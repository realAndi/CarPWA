// carpwad on macOS, against a temporary jailbreak root (CARPWA_JBROOT).
// Run with `make -C Daemon test`, which builds .build/macos/carpwad first.
//
// The tests share one daemon and run in order; later tests build on the
// apps earlier ones pushed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { connectWebSocket } from '../../cli/src/websocket.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = dirname(HERE);
const REPO = dirname(DAEMON_DIR);
const CARPWAD = join(DAEMON_DIR, '.build/macos/carpwad');
const CARPWACTL = join(DAEMON_DIR, '.build/macos/carpwactl');
const CLI = join(REPO, 'cli/bin/carpwa.js');
const FAKE_SSH = join(HERE, 'helpers/fake-ssh.mjs');
const HELLO = 'com.carpwa.example.hello';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (data) => createHash('sha1').update(data).digest('hex');

// ------------------------------------------------------------------ setup

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function pickBasePort() {
  for (let i = 0; i < 50; i++) {
    const base = 40000 + Math.floor(Math.random() * 2000) * 10;
    let ok = true;
    for (let p = base; p < base + 10 && ok; p++) ok = await portFree(p);
    if (ok) return base;
  }
  throw new Error('no free port range');
}

class Daemon {
  constructor(root, base) {
    this.root = root;
    this.base = base;
    this.log = '';
  }

  get data() { return join(this.root, 'var/mobile/Library/CarPWA'); }
  get token() { return readFileSync(join(this.data, 'dev-token'), 'utf8').trim(); }
  get env() { return { ...process.env, CARPWA_JBROOT: this.root, CARPWA_BASE_PORT: String(this.base) }; }

  registry() { return JSON.parse(readFileSync(join(this.data, 'run/apps.json'), 'utf8')); }
  entry(id) { return this.registry().apps.find((a) => a.id === id); }

  async start() {
    this.child = spawn(CARPWAD, [], { env: this.env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (d) => { this.log += d; });
    this.exited = new Promise((r) => this.child.on('exit', (code, signal) => r(code ?? signal)));
    for (let i = 0; i < 100; i++) {
      const r = await request(this.base, 'GET', '/_carpwa/health').catch(() => null);
      if (r && r.status === 200) return;
      await sleep(50);
    }
    throw new Error(`carpwad did not start:\n${this.log}`);
  }

  async stop(signal = 'SIGTERM') {
    if (!this.child || this.child.exitCode !== null) return this.child && this.child.exitCode;
    this.child.kill(signal);
    return this.exited;
  }

  control(method, path, body, headers = {}) {
    return request(this.base, method, path, { body, headers: { 'X-CarPWA-Token': this.token, ...headers } });
  }
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const h = { ...headers };
    if (Buffer.isBuffer(body) || typeof body === 'string') payload = Buffer.from(body);
    else if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; }
    if (payload) h['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A page or tool on the server bridge: call() resolves with the reply envelope. */
function bridge(ws) {
  let nextID = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.on('message', (text) => {
    const msg = JSON.parse(text);
    if (msg.type === 'event') {
      events.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    } else {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) p(msg);
    }
  });
  const b = {
    ws,
    events,
    call(module, method, params = {}) {
      const id = ++nextID;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.sendJSON({ id, type: 'call', module, method, params });
      });
    },
    async ok(module, method, params) {
      const m = await b.call(module, method, params);
      if (m.type !== 'result') throw new Error(`${module}.${method}: ${JSON.stringify(m.error)}`);
      return m.result;
    },
    async fail(module, method, params) {
      const m = await b.call(module, method, params);
      assert.equal(m.type, 'error', `${module}.${method} should fail, got ${JSON.stringify(m)}`);
      return m.error;
    },
    event(match, timeout = 3000) {
      const found = events.find(match);
      if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { match, resolve: (m) => { events.splice(events.indexOf(m), 1); resolve(m); } };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for an event')), timeout).unref();
      });
    },
    close() { ws.close(); },
  };
  return b;
}

async function openPage(port, { key, devtoken, origin } = {}) {
  const q = key ? `?key=${encodeURIComponent(key)}` : devtoken ? `?devtoken=${encodeURIComponent(devtoken)}` : '';
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/_carpwa/ws${q}`, {
    headers: { Origin: origin ?? `http://127.0.0.1:${port}` },
  });
  return bridge(ws);
}

function writeApp(dir, manifest, files = { 'index.html': '<!doctype html><title>t</title>' }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'carpwa.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function runCLI(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function until(fn, what, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

let root;
let work;
let daemon;
let cliEnv;

before(async () => {
  assert.ok(existsSync(CARPWAD), 'build first: make -C Daemon macos');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'carpwad-jb-')));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'carpwad-work-')));
  mkdirSync(join(root, 'Library/CarPWA/SDK'), { recursive: true });
  for (const f of ['carpwa.js', 'carpwa.css', 'carpwa.d.ts']) cpSync(join(REPO, 'sdk/js', f), join(root, 'Library/CarPWA/SDK', f));
  cpSync(join(REPO, 'examples/hello-car'), join(root, 'Library/CarPWA/Apps', HELLO), { recursive: true });
  chmodSync(FAKE_SSH, 0o755);
  daemon = new Daemon(root, await pickBasePort());
  await daemon.start();
  cliEnv = { CARPWA_SSH: FAKE_SSH, FAKE_JBROOT: root, FAKE_BASE_PORT: String(daemon.base), CARPWA_HOME: join(work, 'home'), CARPWA_HOST: 'phone' };
});

after(async () => {
  if (daemon) await daemon.stop('SIGKILL');
  if (process.env.KEEP_TEMP) console.log(`kept ${root} and ${work}\n${daemon && daemon.log}`);
  else {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ tests

test('control server: health is open, everything else needs the token', async () => {
  const health = await request(daemon.base, 'GET', '/_carpwa/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, version: '1.0.0' });

  for (const headers of [{}, { 'X-CarPWA-Token': 'nope' }]) {
    const r = await request(daemon.base, 'GET', '/_carpwa/apps', { headers });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'EPERM');
  }
  const apps = await daemon.control('GET', '/_carpwa/apps');
  assert.equal(apps.status, 200);
  const hello = apps.json.find((a) => a.id === HELLO);
  assert.equal(hello.origin, 'system');
  assert.equal(hello.port, daemon.base + 1);
  assert.equal(hello.url, `http://127.0.0.1:${daemon.base + 1}/index.html`);
  assert.deepEqual(Object.keys(hello).sort(), ['id', 'name', 'origin', 'path', 'port', 'url', 'version']);

  const token = readFileSync(join(daemon.data, 'dev-token'));
  assert.ok(token.toString().trim().length >= 32);
  const mode = (await import('node:fs')).statSync(join(daemon.data, 'dev-token')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('run/apps.json describes each app for the tweak', () => {
  const reg = daemon.registry();
  assert.equal(reg.version, 1);
  assert.equal(reg.controlPort, daemon.base);
  assert.equal(reg.devMode, true);
  assert.equal(typeof reg.generatedAt, 'number');
  const hello = reg.apps.find((a) => a.id === HELLO);
  assert.match(hello.sessionKey, /^[0-9a-f]{32}$/);
  assert.equal(hello.shortName, 'Hello Car');
  assert.equal(hello.backgroundColor, '#000000');
  assert.ok(hello.icon.endsWith(`/Library/CarPWA/Apps/${HELLO}/icon.png`));
  assert.equal(hello.manifest.id, HELLO);
  assert.equal(hello.manifest.startPath, 'index.html');
  assert.deepEqual(hello.permissions, []);
  const ports = JSON.parse(readFileSync(join(daemon.data, 'ports.json'), 'utf8'));
  assert.equal(ports[HELLO], daemon.base + 1);
});

test('app server: files, SDK, Host guard, methods, ranges', async () => {
  const port = daemon.base + 1;
  const index = readFileSync(join(REPO, 'examples/hello-car/index.html'), 'utf8');

  let r = await request(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.equal(r.text, index);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.equal(r.headers['cache-control'], 'no-store');

  r = await request(port, 'GET', '/style.css');
  assert.match(r.headers['content-type'], /^text\/css/);

  r = await request(port, 'GET', '/index.html', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.text, index.slice(0, 10));

  r = await request(port, 'HEAD', '/index.html');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 0);

  for (const path of ['/missing.js', '/carpwa.json/x', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/.hidden']) {
    r = await request(port, 'GET', path);
    assert.equal(r.status, 404, path);
  }

  r = await request(port, 'GET', '/index.html', { headers: { Host: 'evil.example:80' } });
  assert.equal(r.status, 403);
  r = await request(port, 'GET', '/index.html', { headers: { Host: `localhost:${port}` } });
  assert.equal(r.status, 200);

  r = await request(port, 'POST', '/index.html', { body: 'x' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET, HEAD');

  r = await request(port, 'GET', '/_carpwa/sdk.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.match(r.text, /CarPWA SDK/);
  r = await request(port, 'GET', '/_carpwa/sdk.mjs');
  assert.match(r.text, /export default globalThis\.CarPWA;\n$/);
  r = await request(port, 'GET', '/_carpwa/carpwa.css');
  assert.equal(r.status, 200);
  r = await request(port, 'GET', '/_carpwa/manifest');
  assert.equal(r.json.id, HELLO);
  r = await request(port, 'GET', '/_carpwa/nope');
  assert.equal(r.status, 404);
});

test('app server: spa fallback, folders and symlinks', async () => {
  const dir = join(daemon.data, 'Apps/com.test.spa');
  writeApp(dir, { id: 'com.test.spa', name: 'SPA', spa: true, start_url: 'app.html?mode=car' }, {
    'app.html': 'APP', 'docs/index.html': 'DOCS', 'img/a b.png': 'PNG',
  });
  writeFileSync(join(work, 'secret.txt'), 'SECRET');
  (await import('node:fs')).symlinkSync(join(work, 'secret.txt'), join(dir, 'leak.txt'));
  const list = await daemon.control('POST', '/_carpwa/dev/rescan');
  const spa = list.json.find((a) => a.id === 'com.test.spa');
  assert.ok(spa, 'rescan lists the new app');
  assert.equal(spa.url, `http://127.0.0.1:${spa.port}/app.html?mode=car`);
  const port = spa.port;

  let r = await request(port, 'GET', '/');
  assert.equal(r.text, 'APP');
  r = await request(port, 'GET', '/some/route', { headers: { Accept: 'text/html' } });
  assert.equal(r.text, 'APP');
  r = await request(port, 'GET', '/deep/link');
  assert.equal(r.text, 'APP', 'extension-less paths are documents');
  r = await request(port, 'GET', '/missing.png', { headers: { Accept: 'image/png' } });
  assert.equal(r.status, 404);
  r = await request(port, 'GET', '/docs');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/docs/');
  r = await request(port, 'GET', '/docs/');
  assert.equal(r.text, 'DOCS');
  r = await request(port, 'GET', '/img/a%20b.png');
  assert.equal(r.text, 'PNG');
  assert.equal(r.headers['content-type'], 'image/png');
  r = await request(port, 'GET', '/leak.txt');
  assert.equal(r.status, 404, 'a symlink out of the app folder is not served');
});

test('server bridge: Origin and key decide who may connect', async () => {
  const port = daemon.base + 1;
  const key = daemon.entry(HELLO).sessionKey;
  const refused = async (opts) => {
    await assert.rejects(openPage(port, opts), /HTTP 403/);
  };
  await refused({});
  await refused({ key: 'wrong' });
  await refused({ key, origin: 'http://evil.example' });
  await refused({ key, origin: `http://127.0.0.1:${port + 1}` });
  await refused({ devtoken: 'wrong' });

  for (const opts of [{ key }, { key, origin: `http://localhost:${port}` }, { devtoken: daemon.token }]) {
    const page = await openPage(port, opts);
    assert.equal((await page.ok('app', 'info')).id, HELLO);
    page.close();
  }

  // The control port takes tools with the dev token only.
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws`), /HTTP 403/);
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=x`), /HTTP 403/);
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`, {
    headers: { Origin: 'http://evil.example' },
  }), /HTTP 403/);
  const tool = bridge(await connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`, {
    headers: { Origin: `http://127.0.0.1:${daemon.base}` },
  }));
  assert.ok(Array.isArray(await tool.ok('app', 'list')));
  assert.equal((await tool.fail('app', 'info')).code, 'ENOTFOUND');
  tool.close();
});

test('server bridge: app and storage', async () => {
  const port = daemon.base + 1;
  const key = daemon.entry(HELLO).sessionKey;
  const a = await openPage(port, { key });
  const b = await openPage(port, { key });

  assert.deepEqual(await a.ok('app', 'info'), {
    id: HELLO, name: 'Hello Car', version: '1.0.0', port, permissions: [], origin: 'system',
  });
  const list = await a.ok('app', 'list');
  assert.deepEqual(list.find((x) => x.id === HELLO), { id: HELLO, name: 'Hello Car', version: '1.0.0', port, url: `http://127.0.0.1:${port}/index.html` });

  assert.equal(await a.ok('storage', 'get', { key: 'missing' }), null);
  assert.equal(await a.ok('storage', 'set', { key: 'n', value: { deep: [1, 'two', null, true] } }), true);
  assert.deepEqual(await b.ok('storage', 'get', { key: 'n' }), { deep: [1, 'two', null, true] });
  const changed = await b.event((e) => e.module === 'storage' && e.event === 'changed');
  assert.deepEqual(changed.data, { key: 'n', value: { deep: [1, 'two', null, true] } });
  assert.ok(!a.events.some((e) => e.module === 'storage'), 'the writer does not get its own change');

  await a.ok('storage', 'set', { key: 'm', value: 'x' });
  assert.deepEqual(await a.ok('storage', 'keys'), ['m', 'n']);
  assert.deepEqual(await a.ok('storage', 'getAll'), { m: 'x', n: { deep: [1, 'two', null, true] } });
  await a.ok('storage', 'remove', { key: 'm' });
  assert.deepEqual((await b.event((e) => e.module === 'storage' && e.data.key === 'm' && e.data.value === null)).data, { key: 'm', value: null });

  assert.equal((await a.fail('storage', 'set', { key: '', value: 1 })).code, 'EINVAL');
  assert.equal((await a.fail('storage', 'get', {})).code, 'EINVAL');
  const big = await a.fail('storage', 'set', { key: 'big', value: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(big.code, 'EINVAL');
  assert.match(big.message, /full/);

  // Written to disk shortly after the change.
  const file = join(daemon.data, 'Data', HELLO, 'storage.json');
  await until(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).n, 'storage.json');
  assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600);

  await a.ok('storage', 'clear');
  assert.deepEqual((await b.event((e) => e.module === 'storage' && e.data.key === null)).data, { key: null, value: null });
  assert.deepEqual(await b.ok('storage', 'keys'), []);
  a.close();
  b.close();
});

test('server bridge: envelopes and errors', async () => {
  const port = daemon.base + 1;
  const page = await openPage(port, { key: daemon.entry(HELLO).sessionKey });
  assert.equal((await page.fail('nosuch', 'thing')).code, 'ENOTFOUND');
  assert.equal((await page.fail('storage', 'nosuch')).code, 'ENOTFOUND');
  assert.equal((await page.fail('dev', 'tailLogs')).code, 'EPERM', 'tailing needs the dev token');
  assert.equal((await page.fail('net', 'fetch', { url: 'http://127.0.0.1/' })).code, 'EPERM', 'hello lacks "network"');
  assert.equal(await page.ok('storage', '$subscribe', { event: 'changed' }), true);

  // Malformed messages: no id → ignored; bad shape with an id → EINVAL.
  page.ws.send('not json');
  page.ws.sendJSON({ type: 'call', module: 'app', method: 'info' });
  const reply = await new Promise((resolve) => {
    page.ws.once('message', (t) => resolve(JSON.parse(t)));
    page.ws.sendJSON({ id: 99, type: 'nope' });
  });
  assert.deepEqual(reply, { id: 99, type: 'error', error: { code: 'EINVAL', message: reply.error.message } });
  // Still alive.
  assert.equal((await page.ok('app', 'info')).id, HELLO);
  page.close();
});

test('channels reach other apps and tools, not the sender', async () => {
  const hello = await openPage(daemon.base + 1, { key: daemon.entry(HELLO).sessionKey });
  const spaEntry = daemon.entry('com.test.spa');
  const spa = await openPage(spaEntry.port, { key: spaEntry.sessionKey });
  const tool = bridge(await connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`));

  await hello.ok('channel', 'join', { channel: 'telemetry' });
  await tool.ok('channel', 'join', { channel: 'telemetry' });
  await spa.ok('channel', 'join', { channel: 'telemetry' });
  assert.equal(await spa.ok('channel', 'publish', { channel: 'telemetry', data: { speed: 42 } }), 2);
  for (const who of [hello, tool]) {
    const m = await who.event((e) => e.module === 'channel');
    assert.deepEqual(m.data, { channel: 'telemetry', data: { speed: 42 }, from: 'com.test.spa' });
  }
  assert.ok(!spa.events.some((e) => e.module === 'channel'));

  assert.equal(await tool.ok('channel', 'publish', { channel: 'telemetry', data: 'hi' }), 2);
  assert.equal((await hello.event((e) => e.module === 'channel')).data.from, 'dev');

  await hello.ok('channel', 'leave', { channel: 'telemetry' });
  assert.equal(await tool.ok('channel', 'publish', { channel: 'telemetry', data: 1 }), 1);
  spa.close();
  await sleep(200);
  assert.equal(await tool.ok('channel', 'publish', { channel: 'telemetry', data: 1 }), 0, 'closed sockets leave their channels');
  assert.equal((await tool.fail('channel', 'publish', { channel: '' })).code, 'EINVAL');
  hello.close();
  tool.close();
});

test('dev.log reaches tools tailing that app', async () => {
  const tool = bridge(await connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`));
  const all = bridge(await connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`));
  await tool.ok('dev', 'tailLogs', { app: HELLO });
  await all.ok('dev', 'tailLogs', {});
  const hello = await openPage(daemon.base + 1, { key: daemon.entry(HELLO).sessionKey });
  const spaEntry = daemon.entry('com.test.spa');
  const spa = await openPage(spaEntry.port, { key: spaEntry.sessionKey });

  await spa.ok('dev', 'log', { level: 'warn', args: ['from spa'], ts: 1 });
  assert.equal(await hello.ok('dev', 'log', { level: 'info', args: ['hello', { n: 1 }], ts: 1234 }), true);
  const got = await tool.event((e) => e.module === 'dev' && e.event === 'log');
  assert.deepEqual(got.data, { app: HELLO, level: 'info', args: ['hello', { n: 1 }], ts: 1234 });
  assert.ok(!tool.events.some((e) => e.data && e.data.app === 'com.test.spa'), 'filtered by app');
  await all.event((e) => e.data && e.data.app === 'com.test.spa');
  await all.event((e) => e.data && e.data.app === HELLO);

  await hello.ok('dev', 'log', { level: 'bogus', args: 'plain' });
  const normalized = await tool.event((e) => e.module === 'dev');
  assert.equal(normalized.data.level, 'log');
  assert.deepEqual(normalized.data.args, ['plain']);

  // A late tail can ask for what was logged before it connected.
  const late = bridge(await connectWebSocket(`ws://127.0.0.1:${daemon.base}/_carpwa/ws?devtoken=${daemon.token}`));
  await late.ok('dev', 'tailLogs', { app: HELLO, backlog: 2 });
  await until(() => late.events.length >= 2, 'backlog');
  assert.deepEqual(late.events.map((e) => e.data.args[0]), ['hello', 'plain']);

  await tool.ok('dev', 'untailLogs');
  await hello.ok('dev', 'log', { level: 'info', args: ['after untail'] });
  await sleep(200);
  assert.ok(!tool.events.some((e) => e.data && e.data.args[0] === 'after untail'));
  for (const c of [tool, all, hello, spa, late]) c.close();
});

test('net.fetch: allowlist, redirects, text and binary bodies, timeouts', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/json') { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Up': 'yes' }); res.end('{"a":1}'); }
      else if (u.pathname === '/bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from([0, 1, 2, 255])); }
      else if (u.pathname === '/echo') {
        res.writeHead(201, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({ method: req.method, test: req.headers['x-test'], body: Buffer.concat(chunks).toString('base64') }));
      } else if (u.pathname === '/redirect-ok') { res.writeHead(302, { Location: '/json' }); res.end(); }
      else if (u.pathname === '/redirect-bad') { res.writeHead(302, { Location: `http://localhost:${upstream.address().port}/json` }); res.end(); }
      else if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 3000); }
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no'); }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const up = `http://127.0.0.1:${upstream.address().port}`;

  writeApp(join(daemon.data, 'Apps/com.test.net'), {
    id: 'com.test.net', name: 'Net', permissions: ['network'], network: { allow: ['127.0.0.1'] },
  });
  await daemon.control('POST', '/_carpwa/dev/rescan');
  const entry = daemon.entry('com.test.net');
  const page = await openPage(entry.port, { key: entry.sessionKey });

  let r = await page.ok('net', 'fetch', { url: `${up}/json` });
  assert.equal(r.status, 200);
  assert.equal(r.statusText, 'OK');
  assert.equal(r.body, '{"a":1}');
  assert.equal(r.bodyEncoding, 'text');
  assert.equal(r.headers['x-up'], 'yes');
  assert.equal(r.url, `${up}/json`);

  r = await page.ok('net', 'fetch', { url: `${up}/bin` });
  assert.equal(r.bodyEncoding, 'base64');
  assert.equal(r.body, 'AAEC/w==');

  r = await page.ok('net', 'fetch', { url: `${up}/echo`, method: 'post', headers: { 'X-Test': 'T' }, body: Buffer.from([9, 8]).toString('base64'), bodyEncoding: 'base64' });
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(r.body), { method: 'POST', test: 'T', body: 'CQg=' });

  r = await page.ok('net', 'fetch', { url: `${up}/redirect-ok` });
  assert.equal(r.url, `${up}/json`);
  assert.equal(r.body, '{"a":1}');

  r = await page.ok('net', 'fetch', { url: `${up}/missing` });
  assert.equal(r.status, 404);
  assert.equal(r.statusText, 'Not Found');

  let e = await page.fail('net', 'fetch', { url: `${up}/redirect-bad` });
  assert.equal(e.code, 'EPERM');
  assert.match(e.message, /localhost/);
  e = await page.fail('net', 'fetch', { url: 'http://example.com/' });
  assert.equal(e.code, 'EPERM');
  e = await page.fail('net', 'fetch', { url: 'file:///etc/passwd' });
  assert.equal(e.code, 'EINVAL');
  e = await page.fail('net', 'fetch', {});
  assert.equal(e.code, 'EINVAL');
  const started = Date.now();
  e = await page.fail('net', 'fetch', { url: `${up}/slow`, timeout: 1 });
  assert.equal(e.code, 'ETIMEOUT');
  assert.ok(Date.now() - started < 2500);
  page.close();
});

// ---------------------------------------------------------- raw frames

function clientFrame(opcode, payload, fin = true) {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len])
    : len < 65536 ? Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]), Buffer.from([len >> 8, len & 255])])
      : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

async function rawSocket(port, path, origin) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const key = randomBytes(16).toString('base64');
  sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  const frames = [];
  let handshake = null;
  const waiters = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!handshake) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buf.subarray(0, end).toString();
      buf = buf.subarray(end + 4);
    }
    while (buf.length >= 2) {
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      frames.push({ opcode: buf[0] & 15, fin: !!(buf[0] & 0x80), payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
      for (const w of waiters.splice(0)) w();
    }
  });
  await until(() => handshake, 'handshake');
  assert.match(handshake, /^HTTP\/1\.1 101/);
  return {
    sock,
    frames,
    send: (b) => sock.write(b),
    async next() {
      await until(() => frames.length, 'a frame');
      return frames.shift();
    },
  };
}

test('WebSocket frames: fragmented messages, large messages, ping, close', async () => {
  const entry = daemon.entry(HELLO);
  const port = entry.port;
  const raw = await rawSocket(port, `/_carpwa/ws?key=${entry.sessionKey}`, `http://127.0.0.1:${port}`);

  const msg = Buffer.from(JSON.stringify({ id: 1, type: 'call', module: 'app', method: 'info', params: {} }));
  raw.send(clientFrame(1, msg.subarray(0, 5), false));
  raw.send(clientFrame(9, Buffer.from('mid')));            // control frames may come between fragments
  raw.send(clientFrame(0, msg.subarray(5, 20), false));
  raw.send(clientFrame(0, msg.subarray(20), true));
  let f = await raw.next();
  if (f.opcode === 10) { assert.equal(f.payload.toString(), 'mid'); f = await raw.next(); }
  assert.equal(f.opcode, 1);
  assert.equal(JSON.parse(f.payload).result.id, HELLO);

  const big = 'y'.repeat(1024 * 1024);
  raw.send(clientFrame(1, Buffer.from(JSON.stringify({ id: 2, type: 'call', module: 'storage', method: 'set', params: { key: 'big', value: big } }))));
  f = await raw.next();
  assert.deepEqual(JSON.parse(f.payload), { id: 2, type: 'result', result: true });
  raw.send(clientFrame(1, Buffer.from(JSON.stringify({ id: 3, type: 'call', module: 'storage', method: 'get', params: { key: 'big' } }))));
  f = await raw.next();
  assert.equal(JSON.parse(f.payload).result.length, big.length);
  raw.send(clientFrame(1, Buffer.from(JSON.stringify({ id: 4, type: 'call', module: 'storage', method: 'remove', params: { key: 'big' } }))));
  await raw.next();

  // A continuation without a start is a protocol error: the server closes with 1002.
  raw.send(clientFrame(0, Buffer.from('stray'), true));
  f = await raw.next();
  assert.equal(f.opcode, 8);
  assert.equal(f.payload.readUInt16BE(0), 1002);
  raw.sock.destroy();

  // A clean close is answered with the same code.
  const raw2 = await rawSocket(port, `/_carpwa/ws?key=${entry.sessionKey}`, `http://127.0.0.1:${port}`);
  raw2.send(clientFrame(8, Buffer.from([0x03, 0xe8])));
  f = await raw2.next();
  assert.equal(f.opcode, 8);
  assert.equal(f.payload.readUInt16BE(0), 1000);
  raw2.sock.destroy();
});

// ------------------------------------------------------------- the CLI

test('carpwa push / list / reload / remove against carpwad', async () => {
  const dir = join(work, 'pushy');
  let r = await runCLI(['create', dir, '--template', 'media', '--id', 'com.test.push', '--name', 'Pushy'], cliEnv);
  assert.equal(r.code, 0, r.stderr);

  r = await runCLI(['push', dir], cliEnv);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const appDir = join(daemon.data, 'Apps/com.test.push');
  for (const f of ['carpwa.json', 'index.html', 'app.js', 'icon.png']) {
    assert.deepEqual(readFileSync(join(appDir, f)), readFileSync(join(dir, f)), f);
  }
  const entry = daemon.entry('com.test.push');
  assert.ok(entry, 'listed in apps.json');
  assert.equal(entry.origin, 'user');
  assert.equal((await request(entry.port, 'GET', '/app.js')).text, readFileSync(join(dir, 'app.js'), 'utf8'));

  r = await runCLI(['push', dir], cliEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /up to date/);

  // An open page hears about the next push.
  const page = await openPage(entry.port, { key: entry.sessionKey });
  writeFileSync(join(dir, 'app.js'), '// v2\n');
  mkdirSync(join(dir, 'sub/deep'), { recursive: true });
  writeFileSync(join(dir, 'sub/deep/x.txt'), 'x');
  unlinkSync(join(dir, 'style.css'));
  r = await runCLI(['push', dir, '--reload'], cliEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /reloaded\s+1 page/);
  assert.deepEqual((await page.event((e) => e.module === 'dev' && e.event === 'reload')).data, { reason: 'push' });
  assert.equal(readFileSync(join(appDir, 'app.js'), 'utf8'), '// v2\n');
  assert.equal(readFileSync(join(appDir, 'sub/deep/x.txt'), 'utf8'), 'x');
  assert.ok(!existsSync(join(appDir, 'style.css')));

  rmSync(join(dir, 'sub'), { recursive: true });
  r = await runCLI(['push', dir], cliEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(join(appDir, 'sub')), 'empty folders are pruned');
  assert.equal(daemon.entry('com.test.push').sessionKey, entry.sessionKey, 'pushes keep the session key');

  r = await runCLI(['list', '--json'], cliEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).some((a) => a.id === 'com.test.push' && a.origin === 'user'));

  r = await runCLI(['remove', 'com.test.push'], cliEnv);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(appDir));
  assert.equal(daemon.entry('com.test.push'), undefined);
  await assert.rejects(request(entry.port, 'GET', '/'), 'its server is gone');
  page.close();
});

test('carpwa dev: syncs saves, reloads pages and streams the page console', async () => {
  const dir = join(work, 'devapp');
  let r = await runCLI(['create', dir, '--id', 'com.test.dev', '--name', 'Devvy'], cliEnv);
  assert.equal(r.code, 0, r.stderr);

  const child = spawn(process.execPath, [CLI, 'dev', dir], { env: { ...process.env, NO_COLOR: '1', ...cliEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await until(() => /Watching/.test(output), `carpwa dev to start:\n${output}`, 15000);
    const entry = daemon.entry('com.test.dev');
    assert.ok(entry, 'the first push registered the app');
    const page = await openPage(entry.port, { key: entry.sessionKey });

    await sleep(300);   // let the watcher settle
    writeFileSync(join(dir, 'app.js'), 'console.log("v2");\n');
    assert.deepEqual((await page.event((e) => e.module === 'dev' && e.event === 'reload', 8000)).data, { reason: 'push' });
    assert.equal(readFileSync(join(daemon.data, 'Apps/com.test.dev/app.js'), 'utf8'), 'console.log("v2");\n');
    await until(() => /sync .*app\.js/.test(output), 'the sync line');

    await page.ok('dev', 'log', { level: 'info', args: ['hello from the page', { n: 1 }], ts: Date.now() });
    await until(() => /hello from the page/.test(output), `the page log in the dev output:\n${output}`);
    page.close();
  } finally {
    child.kill('SIGINT');
  }
  assert.equal(await exited, 0, output);
});

test('control API: read-only system apps, broken manifests, bad paths, dev mode', async () => {
  let r = await daemon.control('POST', `/_carpwa/dev/apps/${HELLO}/sync`, { files: { 'carpwa.json': '0'.repeat(40) } });
  assert.equal(r.status, 403);
  r = await daemon.control('DELETE', `/_carpwa/dev/apps/${HELLO}`);
  assert.equal(r.status, 403);
  r = await daemon.control('DELETE', '/_carpwa/dev/apps/com.test.none');
  assert.equal(r.status, 404);
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.none/reload');
  assert.equal(r.status, 404);
  r = await daemon.control('POST', '/_carpwa/dev/apps/bad%20id/sync', { files: {} });
  assert.equal(r.status, 400);
  r = await daemon.control('GET', '/_carpwa/nope');
  assert.equal(r.status, 404);

  for (const bad of ['../x', '.git/config', 'a//b', 'a/./b']) {
    r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.broken/sync', { files: { 'carpwa.json': '0'.repeat(40), [bad]: '0'.repeat(40) } });
    assert.equal(r.status, 400, bad);
  }

  // A manifest that does not parse: copied, but refused with the reason.
  const broken = Buffer.from('{ "id": "com.test.broken", ');
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.broken/sync', { files: { 'carpwa.json': sha1(broken) } });
  assert.deepEqual(r.json, { need: ['carpwa.json'], remove: [] });
  r = await daemon.control('PUT', '/_carpwa/dev/apps/com.test.broken/files/carpwa.json', Buffer.from('tampered'));
  assert.equal(r.status, 400, 'PUT bodies must match the hashes sent with sync');
  r = await daemon.control('PUT', '/_carpwa/dev/apps/com.test.broken/files/carpwa.json', broken);
  assert.equal(r.status, 200);
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.broken/commit', { remove: [] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'EINVAL');
  assert.match(r.json.error.message, /not valid JSON/);
  r = await daemon.control('DELETE', '/_carpwa/dev/apps/com.test.broken');
  assert.equal(r.status, 200);

  // A large upload is spooled to disk and moved into place.
  const blob = randomBytes(3 * 1024 * 1024);
  const manifest = Buffer.from(JSON.stringify({ id: 'com.test.blob', name: 'Blob' }));
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.blob/sync', { files: { 'carpwa.json': sha1(manifest), 'index.html': sha1('x'), 'blob.bin': sha1(blob) } });
  assert.deepEqual(r.json.need, ['blob.bin', 'carpwa.json', 'index.html']);
  for (const [rel, body] of [['carpwa.json', manifest], ['index.html', Buffer.from('x')], ['blob.bin', blob]]) {
    r = await daemon.control('PUT', `/_carpwa/dev/apps/com.test.blob/files/${rel}`, body);
    assert.equal(r.status, 200, rel);
  }
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.blob/commit', { remove: [] });
  assert.equal(r.status, 200);
  const blobPort = r.json.port;
  assert.deepEqual((await request(blobPort, 'GET', '/blob.bin')).body, blob);
  await daemon.control('DELETE', '/_carpwa/dev/apps/com.test.blob');

  // Dev mode off: pushes are refused, listing still works.
  writeFileSync(join(daemon.data, 'config.json'), JSON.stringify({ devMode: false }));
  await daemon.control('POST', '/_carpwa/dev/rescan');
  r = await daemon.control('POST', '/_carpwa/dev/apps/com.test.x/sync', { files: { 'carpwa.json': '0'.repeat(40) } });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /dev mode is off/);
  assert.equal(daemon.registry().devMode, false);
  unlinkSync(join(daemon.data, 'config.json'));
  await daemon.control('POST', '/_carpwa/dev/rescan');
  assert.equal(daemon.registry().devMode, true);
});

test('ports stay with their app and are never handed to another', async () => {
  const before = JSON.parse(readFileSync(join(daemon.data, 'ports.json'), 'utf8'));
  assert.ok(before['com.test.push'], 'the removed app keeps its assignment');
  writeApp(join(daemon.data, 'Apps/com.test.newcomer'), { id: 'com.test.newcomer', name: 'New' });
  await daemon.control('POST', '/_carpwa/dev/rescan');
  const port = daemon.entry('com.test.newcomer').port;
  assert.ok(!Object.values(before).includes(port), `${port} was never used before`);
  const after = JSON.parse(readFileSync(join(daemon.data, 'ports.json'), 'utf8'));
  for (const [id, p] of Object.entries(before)) assert.equal(after[id], p);
});

test('folder watchers, carpwactl rescan and the apps-changed notification', async () => {
  // Edited in place: the manifest watcher sees it.
  const dir = join(daemon.data, 'Apps/com.test.newcomer');
  writeFileSync(join(dir, 'carpwa.json'), JSON.stringify({ id: 'com.test.newcomer', name: 'Renamed' }));
  await until(() => daemon.entry('com.test.newcomer')?.name === 'Renamed', 'the rename');

  // A new folder: the Apps folder watcher sees it; the tweak is notified.
  const notified = spawn('notifyutil', ['-1', 'com.andi.carpwa/apps-changed'], { stdio: 'ignore' });
  const gotNotification = new Promise((r) => notified.on('exit', () => r(true)));
  await sleep(200);
  writeApp(join(root, 'Library/CarPWA/Apps/com.test.pkg'), { id: 'com.test.pkg', name: 'Pkg' });
  await until(() => daemon.entry('com.test.pkg'), 'the packaged app');
  assert.equal(daemon.entry('com.test.pkg').origin, 'system');
  assert.equal(await Promise.race([gotNotification, sleep(3000).then(() => false)]), true, 'apps-changed was posted');
  notified.kill();

  // A folder whose name does not match its id is skipped.
  writeApp(join(daemon.data, 'Apps/wrong-name'), { id: 'com.test.other', name: 'X' });
  // carpwactl rescan (what package scripts run) is picked up.
  const ctl = spawn(CARPWACTL, ['rescan'], { env: daemon.env });
  assert.equal(await new Promise((r) => ctl.on('exit', r)), 0);
  await sleep(800);
  assert.equal(daemon.entry('com.test.other'), undefined);
  assert.match(daemon.log, /folder must be named after the id/);

  const status = await new Promise((resolve) => {
    const c = spawn(CARPWACTL, ['status'], { env: daemon.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  assert.equal(status.code, 0);
  assert.match(status.out, /carpwad 1\.0\.0 is running/);
  assert.match(status.out, /com\.test\.pkg/);
});

test('a restart keeps ports and storage; SIGTERM unpublishes the apps', async () => {
  const ports = Object.fromEntries(daemon.registry().apps.map((a) => [a.id, a.port]));
  const entry = daemon.entry(HELLO);
  const page = await openPage(entry.port, { key: entry.sessionKey });
  await page.ok('storage', 'set', { key: 'persist', value: 7 });
  page.close();

  assert.equal(await daemon.stop('SIGTERM'), 0);
  const stopped = daemon.registry();
  assert.equal(stopped.running, false);
  assert.deepEqual(stopped.apps, []);
  const stored = JSON.parse(readFileSync(join(daemon.data, 'Data', HELLO, 'storage.json'), 'utf8'));
  assert.equal(stored.persist, 7, 'pending storage is flushed on SIGTERM');

  await daemon.start();
  const again = daemon.registry();
  assert.equal(again.running, true);
  for (const a of again.apps) assert.equal(a.port, ports[a.id], a.id);
  const newKey = daemon.entry(HELLO).sessionKey;
  assert.notEqual(newKey, entry.sessionKey, 'session keys are per daemon run');
  const page2 = await openPage(entry.port, { key: newKey });
  assert.equal(await page2.ok('storage', 'get', { key: 'persist' }), 7);
  page2.close();
});

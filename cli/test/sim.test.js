import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimServer } from '../src/simserver.js';
import { connectWebSocket } from '../src/websocket.js';
import { tempDir, runCLI, startCLI } from './helpers/util.js';

async function makeApp(t, template = 'blank', patch = {}) {
  const root = tempDir(t);
  const dir = join(root, 'app');
  const r = await runCLI(['create', dir, '--template', template, '--id', 'com.test.sim']);
  assert.equal(r.code, 0, r.stderr);
  if (Object.keys(patch).length) {
    const m = JSON.parse(readFileSync(join(dir, 'carpwa.json'), 'utf8'));
    writeFileSync(join(dir, 'carpwa.json'), JSON.stringify({ ...m, ...patch }));
  }
  return { root, dir };
}

async function startSim(t, dir) {
  process.env.CARPWA_HOME = tempDir(t, 'carpwa-home-');
  const sim = new SimServer({ dir, port: 0, preset: 'standard', input: 'touch' });
  const port = await sim.listen();
  t.after(() => sim.close());
  return { sim, port };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.on('message', (text) => {
      const msg = JSON.parse(text);
      if (msg.type === 'event') { this.events.push(msg); return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }
  call(module, method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.sendJSON({ id, type: 'call', module, method, params });
    });
  }
  static async open(port, query = '?sim=1', origin = `http://127.0.0.1:${port}`) {
    const ws = await connectWebSocket(`ws://127.0.0.1:${port}/_carpwa/ws${query}`, { headers: origin ? { Origin: origin } : {} });
    return new Client(ws);
  }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('serves the app, the SDK and the simulator shell', async (t) => {
  const { dir } = await makeApp(t, 'blank', { spa: true });
  const { port } = await startSim(t, dir);

  const shell = await get(port, '/__carpwa_sim/');
  assert.equal(shell.status, 200);
  assert.match(shell.body, /CarPWA Simulator/);
  assert.equal(shell.headers['x-frame-options'], 'DENY');

  const page = await get(port, '/', { 'Sec-Fetch-Dest': 'document' });
  assert.equal(page.status, 200, '/ is the app itself');
  assert.match(page.body, /\/_carpwa\/sdk\.js/);
  assert.equal(page.headers['cache-control'], 'no-cache');

  const spa = await get(port, '/deep/route', { Accept: 'text/html' });
  assert.equal(spa.status, 200);
  assert.match(spa.body, /<!doctype html>/i);
  assert.equal((await get(port, '/missing.js')).status, 404);
  const traversal = await get(port, '/..%2f..%2fetc/passwd');
  assert.doesNotMatch(traversal.body, /root:/);
  assert.equal((await get(port, '/.git/config')).status, 200, 'spa fallback, never the dot-file');

  const css = await get(port, '/style.css');
  assert.match(css.headers['content-type'], /^text\/css/);

  const sdk = await get(port, '/_carpwa/sdk.js');
  assert.equal(sdk.status, 200);
  assert.match(sdk.body, /CarPWA SDK/);
  assert.equal(sdk.headers['cache-control'], 'no-cache');
  const mjs = await get(port, '/_carpwa/sdk.mjs');
  assert.match(mjs.body, /export default globalThis\.CarPWA;\n$/);
  assert.match((await get(port, '/_carpwa/carpwa.css')).headers['content-type'], /text\/css/);
  const manifest = JSON.parse((await get(port, '/_carpwa/manifest')).body);
  assert.equal(manifest.id, 'com.test.sim');
  assert.equal(manifest.spa, true);

  assert.equal((await get(port, '/', { Host: 'evil.example:80' })).status, 403);
});

test('server bridge: app, storage, channels, errors', async (t) => {
  const { dir } = await makeApp(t);
  const { sim, port } = await startSim(t, dir);
  const a = await Client.open(port);
  const b = await Client.open(port, '');

  const info = await a.call('app', 'info');
  assert.deepEqual(info.result, { id: 'com.test.sim', name: 'App', version: '1.0.0', port, permissions: [], origin: 'user' });
  assert.equal((await a.call('app', 'list')).result[0].url, `http://127.0.0.1:${port}/index.html`);

  assert.equal((await a.call('storage', 'set', { key: 'k', value: { n: 1 } })).result, true);
  assert.deepEqual((await b.call('storage', 'get', { key: 'k' })).result, { n: 1 });
  assert.equal((await b.call('storage', 'get', { key: 'nope' })).result, null);
  assert.deepEqual((await b.call('storage', 'keys')).result, ['k']);
  await tick();
  assert.deepEqual(b.events.find((e) => e.event === 'changed').data, { key: 'k', value: { n: 1 } });
  assert.equal(a.events.filter((e) => e.event === 'changed').length, 0, 'the writer does not get its own change');
  assert.equal((await a.call('storage', 'set', { value: 1 })).error.code, 'EINVAL');
  assert.deepEqual(JSON.parse(readFileSync(sim.storageFile, 'utf8')), { k: { n: 1 } });

  await b.call('channel', 'join', { channel: 'c1' });
  assert.equal((await a.call('channel', 'publish', { channel: 'c1', data: [1, 2] })).result, 1);
  await tick();
  assert.deepEqual(b.events.find((e) => e.module === 'channel').data, { channel: 'c1', data: [1, 2], from: 'com.test.sim' });
  assert.equal((await a.call('channel', 'publish', { channel: 'c2', data: null })).result, 0);

  assert.equal((await a.call('net', 'fetch', { url: 'https://example.com' })).error.code, 'EPERM');
  assert.equal((await a.call('nope', 'x')).error.code, 'ENOTFOUND');
  assert.equal((await a.call('storage', 'explode')).error.code, 'ENOTFOUND');
  assert.equal((await a.call('dev', 'tailLogs')).error.code, 'EPERM');

  const logged = new Promise((r) => sim.bridge.once('log', r));
  await a.call('dev', 'log', { level: 'warn', args: ['hi', { x: 1 }], ts: 5 });
  assert.deepEqual(await logged, { level: 'warn', args: ['hi', { x: 1 }], ts: 5 });

  assert.equal((await a.call('storage', 'clear')).result, true);
  await tick();
  assert.deepEqual(b.events.filter((e) => e.event === 'changed').at(-1).data, { key: null, value: null });
});

test('the WebSocket refuses other sites but lets tools in', async (t) => {
  const { dir } = await makeApp(t);
  const { port } = await startSim(t, dir);
  await assert.rejects(Client.open(port, '?sim=1', 'https://evil.example'), /403/);
  await assert.rejects(Client.open(port, '?sim=1', `http://127.0.0.1:${port + 1}`), /403/);
  const browser = await Client.open(port, '?sim=1', `http://localhost:${port}`);
  assert.equal((await browser.call('storage', 'keys')).result.length, 0);
  const tool = await Client.open(port, '?sim=1', null);
  assert.equal((await tool.call('app', 'info')).result.id, 'com.test.sim');
});

test('net.fetch honours network.allow, encodes binary bodies and checks redirects', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ method: req.method, ua: req.headers['x-test'] })); return; }
    if (req.url === '/bin') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from([0, 1, 2, 255])); return; }
    if (req.url === '/away') { res.writeHead(302, { Location: 'http://localhost:1/x' }); res.end(); return; }
    if (req.url === '/echo') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { res.writeHead(201, { 'Content-Type': 'text/plain' }); res.end(b); }); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const up = upstream.address().port;

  const { dir } = await makeApp(t, 'blank', { permissions: ['network'], network: { allow: ['127.0.0.1'] } });
  const { port } = await startSim(t, dir);
  const a = await Client.open(port);

  const r1 = (await a.call('net', 'fetch', { url: `http://127.0.0.1:${up}/json`, headers: { 'X-Test': 'yes' } })).result;
  assert.equal(r1.status, 200);
  assert.equal(r1.bodyEncoding, 'text');
  assert.deepEqual(JSON.parse(r1.body), { method: 'GET', ua: 'yes' });

  const r2 = (await a.call('net', 'fetch', { url: `http://127.0.0.1:${up}/bin` })).result;
  assert.equal(r2.bodyEncoding, 'base64');
  assert.deepEqual([...Buffer.from(r2.body, 'base64')], [0, 1, 2, 255]);

  const r3 = (await a.call('net', 'fetch', { url: `http://127.0.0.1:${up}/echo`, method: 'POST', body: 'aGk=', bodyEncoding: 'base64' })).result;
  assert.equal(r3.status, 201);
  assert.equal(r3.body, 'hi');

  assert.equal((await a.call('net', 'fetch', { url: `http://127.0.0.1:${up}/away` })).error.code, 'EPERM');
  assert.equal((await a.call('net', 'fetch', { url: 'http://localhost:9/' })).error.code, 'EPERM');
  assert.equal((await a.call('net', 'fetch', { url: 'file:///etc/passwd' })).error.code, 'EINVAL');
});

test('file changes: dev.reload to every page, manifest updates to the shell', async (t) => {
  const { dir } = await makeApp(t);
  const { sim, port } = await startSim(t, dir);
  sim.startWatching();
  const pageA = await Client.open(port);
  const pageB = await Client.open(port, '');
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/__carpwa_sim/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const messages = [];
  ws.on('message', (text) => messages.push(JSON.parse(text)));
  const waitFor = async (type, file) => {
    for (let i = 0; i < 60; i++) {
      const m = messages.find((x) => x.type === type && (!file || x.files.includes(file)));
      if (m) { messages.splice(messages.indexOf(m), 1); return m; }
      await tick(50);
    }
    throw new Error(`no ${type} message; got ${messages.map((m) => m.type)}`);
  };

  const hello = await waitFor('hello');
  assert.equal(hello.app.manifest.id, 'com.test.sim');
  assert.deepEqual(hello.presets.ultrawide, { width: 1920, height: 720, scale: 1, physical: [322, 108], label: 'Ultrawide · 1920×720' });
  // FSEvents may still report the files `create` just wrote; let them pass.
  await tick(600);
  messages.length = 0;

  pageA.events.length = 0;
  pageB.events.length = 0;

  appendFileSync(join(dir, 'app.js'), '\n// change\n');
  const notice = await waitFor('reload', 'app.js');
  assert.deepEqual(notice.files, ['app.js']);
  assert.equal(notice.pages, 2);
  for (const p of [pageA, pageB]) {
    assert.deepEqual(p.events.find((e) => e.module === 'dev'), { type: 'event', module: 'dev', event: 'reload', data: { reason: 'app.js changed' } });
  }

  appendFileSync(join(dir, 'style.css'), '\nbody{}\n');
  assert.equal((await waitFor('reload', 'style.css')).pages, 2, 'CSS changes reload too');

  const manifestPath = join(dir, 'carpwa.json');
  const good = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, good.replace('"permissions": []', '"permissions": ["warp"]'));
  const bad = await waitFor('manifest');
  assert.match(bad.app.errors[0], /unknown permission "warp"/);
  assert.equal(bad.app.manifest.id, 'com.test.sim', 'keeps serving the last good manifest');

  writeFileSync(manifestPath, good.replace('"permissions": []', '"permissions": ["media"]'));
  const fixed = await waitFor('manifest');
  assert.deepEqual(fixed.app.errors, []);
  assert.deepEqual(fixed.app.manifest.permissions, ['media']);
  ws.close();
});

test('acceptance: a scripted check against `carpwa sim` itself', async (t) => {
  const { root, dir } = await makeApp(t, 'media');
  const home = tempDir(t, 'carpwa-home-');
  const cli = startCLI(['sim', dir, '--port', '0', '--preset', 'wide'], { env: { CARPWA_HOME: home } });
  t.after(() => cli.stop());
  const out = await cli.waitFor(/Simulator\s+http:\/\/127\.0\.0\.1:(\d+)\/__carpwa_sim\//);
  const port = Number(/127\.0\.0\.1:(\d+)\/__carpwa_sim/.exec(out)[1]);
  assert.match(await cli.waitFor(/Screen/), /wide 1280×720/);

  // 1. the SDK
  assert.equal((await get(port, '/_carpwa/sdk.js')).status, 200);
  // 2. storage round-trip over the server bridge
  const a = await Client.open(port, '?sim=1', null);
  const b = await Client.open(port, '?sim=1', null);
  assert.equal((await a.call('storage', 'set', { key: 'speed', value: 88 })).result, true);
  assert.equal((await b.call('storage', 'get', { key: 'speed' })).result, 88);
  // 3. channel publish reaches a second connection
  await b.call('channel', 'join', { channel: 'dash' });
  assert.equal((await a.call('channel', 'publish', { channel: 'dash', data: { rpm: 3000 } })).result, 1);
  await tick(50);
  assert.deepEqual(b.events.find((e) => e.module === 'channel').data, { channel: 'dash', data: { rpm: 3000 }, from: 'com.test.sim' });
  // 4. net.fetch without the "network" permission
  const denied = await a.call('net', 'fetch', { url: 'https://example.com/' });
  assert.equal(denied.error.code, 'EPERM');
  // 5. a file change sends dev.reload
  await tick(600);
  appendFileSync(join(dir, 'app.js'), '\n// touched\n');
  for (let i = 0; i < 60 && !a.events.some((e) => e.module === 'dev' && e.event === 'reload'); i++) await tick(50);
  assert.ok(a.events.some((e) => e.module === 'dev' && e.event === 'reload'), 'dev.reload arrived');
  await cli.waitFor(/reload app\.js → dev\.reload to 2 pages/);
  // dev.log prints in the terminal with the app id
  await a.call('dev', 'log', { level: 'warn', args: ['low fuel', { range: 12 }], ts: Date.now() });
  await cli.waitFor(/com\.test\.sim warn low fuel \{"range":12\}/);
  assert.ok(root);
});

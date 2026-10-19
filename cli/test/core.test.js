import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, gunzipSync } from 'node:zlib';
import { crc32, encodePNG, readPNGInfo, drawIcon } from '../src/png.js';
import { validateApp, hostAllowed, compareVersions } from '../src/manifest.js';
import { compileIgnore, listAppFiles } from '../src/files.js';
import { resolveAppPath } from '../src/static.js';
import { parseArgs } from '../src/args.js';
import { tar, ar, buildDeb } from '../src/deb.js';
import { diffTrees, planSync, encodeRelPath, hashTree, appPath } from '../src/sync.js';
import { takeGlobals } from '../src/cli.js';
import { globals } from '../src/log.js';
import { createHash } from 'node:crypto';
import { tempDir } from './helpers/util.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('encodePNG produces a decodable image', () => {
  const w = 3; const h = 2;
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 0xff;
  const png = encodePNG(w, h, px);
  assert.deepEqual(readPNGInfo(png), { width: 3, height: 2, bitDepth: 8, colorType: 6 });
  // Undo the scanline filters and compare with the input.
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  const raw = inflateSync(idat);
  const stride = w * 4;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f];
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  assert.deepEqual(out, px);
});

test('drawIcon makes a 512×512 PNG', () => {
  assert.deepEqual(readPNGInfo(drawIcon({ size: 64 })), { width: 64, height: 64, bitDepth: 8, colorType: 6 });
  assert.equal(readPNGInfo(Buffer.from('GIF89a')), null);
});

function makeApp(t, manifest, files = {}) {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'carpwa.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  const all = { 'index.html': '<!doctype html>', 'icon.png': drawIcon({ size: 180 }), ...files };
  for (const [name, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test('a minimal manifest is valid and gets defaults', (t) => {
  const r = validateApp(makeApp(t, { id: 'com.example.app', name: 'App' }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.manifest.start_url, 'index.html');
  assert.equal(r.manifest.version, '0.0.0');
  assert.equal(r.manifest.short_name, 'App');
  assert.deepEqual(r.manifest.permissions, []);
});

test('manifest errors', (t) => {
  const cases = [
    [{ name: 'X' }, /"id" is required/],
    [{ id: 'com.x', name: 'X', extra: 1, permissions: ['gps'] }, /unknown permission "gps"/],
    [{ id: 'bad id', name: 'X' }, /may only use letters/],
    [{ id: 'a'.repeat(129), name: 'X' }, /1–128/],
    [{ id: '..', name: 'X' }, /not a usable folder name/],
    [{ id: 'com.x' }, /"name" is required/],
    [{ id: 'com.x', name: 'X', network: { allow: ['api.x.com'] } }, /lacks "network"/],
    [{ id: 'com.x', name: 'X', permissions: ['network'], network: { allow: ['https://x.com/'] } }, /bare host/],
    [{ id: 'com.x', name: 'X', start_url: 'missing.html' }, /missing.html does not exist/],
    [{ id: 'com.x', name: 'X', start_url: 'https://x.com' }, /not a URL/],
    [{ id: 'com.x', name: 'X', start_url: '../outside.html' }, /outside the app folder/],
    [{ id: 'com.x', name: 'X', spa: 'yes' }, /"spa" must be true or false/],
    [{ id: 'com.x', name: 'X', version: 1 }, /"version" must be a string/],
    [{ id: 'com.x', name: 'X', min_carpwa: 'one' }, /"min_carpwa"/],
  ];
  for (const [manifest, re] of cases) {
    const r = validateApp(makeApp(t, manifest));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(manifest)} → ${JSON.stringify(r.errors)}`);
    assert.equal(r.manifest, null);
  }
});

test('icon checks: PNG, square, at least 180', (t) => {
  let r = validateApp(makeApp(t, { id: 'com.x', name: 'X' }, { 'icon.png': drawIcon({ size: 120 }) }));
  assert.ok(r.errors.some((e) => /at least 180/.test(e)));
  r = validateApp(makeApp(t, { id: 'com.x', name: 'X' }, { 'icon.png': encodePNG(200, 190, Buffer.alloc(200 * 190 * 4)) }));
  assert.ok(r.errors.some((e) => /must be square/.test(e)));
  r = validateApp(makeApp(t, { id: 'com.x', name: 'X', icon: 'img/i.png' }, { 'img/i.png': 'not a png' }));
  assert.ok(r.errors.some((e) => /not a PNG/.test(e)));
  r = validateApp(makeApp(t, { id: 'com.x', name: 'X' }, { 'icon.png': null }));
  assert.ok(r.errors.some((e) => /icon icon.png does not exist/.test(e)));
});

test('manifest warnings', (t) => {
  const r = validateApp(makeApp(t, {
    id: 'myapp', name: 'A Very Long Application Name', permissions: ['network', 'car.raw'], startUrl: 'x',
  }));
  assert.deepEqual(r.errors, []);
  const all = r.warnings.join('\n');
  assert.match(all, /not reverse-DNS/);
  assert.match(all, /short_name/);
  assert.match(all, /every net.fetch call will be refused/);
  assert.match(all, /car.raw/);
  assert.match(all, /did you mean "start_url"/);
});

test('invalid JSON reports line and column', (t) => {
  const r = validateApp(makeApp(t, '{\n  "id": "x",\n}'));
  assert.match(r.errors[0], /not valid JSON/);
  assert.match(r.errors[0], /line 3/);
});

test('network.allow host matching', () => {
  const allow = ['api.example.com', '*.cdn.net'];
  assert.ok(hostAllowed('api.example.com', allow));
  assert.ok(hostAllowed('API.example.com.', allow));
  assert.ok(!hostAllowed('example.com', allow));
  assert.ok(hostAllowed('a.cdn.net', allow));
  assert.ok(hostAllowed('a.b.cdn.net', allow));
  assert.ok(!hostAllowed('cdn.net', allow));
  assert.ok(!hostAllowed('evilcdn.net', allow));
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('0.9', '1'), -1);
});

test('ignore rules', () => {
  const ig = compileIgnore(['*.log', 'build/', '/secret.txt', 'docs/**/*.md', '!keep.log']);
  assert.ok(ig('a.log', false));
  assert.ok(ig('x/a.log', false));
  assert.ok(!ig('keep.log', false));
  assert.ok(ig('build', true));
  assert.ok(!ig('build', false));
  assert.ok(ig('secret.txt', false));
  assert.ok(!ig('x/secret.txt', false));
  assert.ok(ig('docs/a/b/c.md', false));
  assert.ok(ig('docs/c.md', false));
});

test('listAppFiles skips dot-files, node_modules and .carpwaignore matches', (t) => {
  const dir = makeApp(t, { id: 'com.x', name: 'X' }, {
    '.git/HEAD': 'x', '.env': 'x', 'node_modules/a/index.js': 'x', 'src/app.js': 'x', 'notes.md': 'x', '.carpwaignore': '*.md\n',
  });
  assert.deepEqual(listAppFiles(dir).map((f) => f.rel), ['carpwa.json', 'icon.png', 'index.html', 'src/app.js']);
});

test('resolveAppPath refuses traversal and dot-files', () => {
  const root = '/srv/app';
  assert.equal(resolveAppPath(root, '/index.html'), '/srv/app/index.html');
  assert.equal(resolveAppPath(root, '/a/../../etc/passwd'), null);
  assert.equal(resolveAppPath(root, '/%2e%2e/etc/passwd'), null);
  assert.equal(resolveAppPath(root, '/..%2fetc'), null);
  assert.equal(resolveAppPath(root, '/.git/config'), null);
  assert.equal(resolveAppPath(root, '/a%00b'), null);
  assert.equal(resolveAppPath(root, '/a%5c..%5cb'), null);
  assert.equal(resolveAppPath(root, '/%E0%A4%A'), null);
});

test('parseArgs', () => {
  const spec = { port: { type: 'number', alias: 'p' }, open: { type: 'boolean' }, reload: { type: 'boolean', default: true }, name: { type: 'string' } };
  assert.deepEqual(parseArgs(['dir', '-p', '80', '--open', '--name=x y'], spec), { opts: { reload: true, port: 80, open: true, name: 'x y' }, positionals: ['dir'] });
  assert.equal(parseArgs(['--no-reload'], spec).opts.reload, false);
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option/);
  assert.throws(() => parseArgs(['--port', 'x'], spec), /needs a number/);
});

function readTar(buf) {
  const out = [];
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString().replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136), 8);
    const type = str(156, 157);
    const sum = parseInt(str(148, 156), 8);
    const copy = Buffer.from(h); copy.fill(0x20, 148, 156);
    assert.equal(copy.reduce((a, b) => a + b, 0), sum, 'tar checksum');
    const data = buf.subarray(off + 512, off + 512 + size);
    const prefix = str(345, 500);
    const name = paxPath || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { paxPath = /path=(.*)\n/.exec(data.toString())[1]; continue; }
    paxPath = null;
    out.push({ name, type, size, mode: parseInt(str(100, 108), 8), data });
  }
  return out;
}

test('tar handles long paths with ustar prefix and pax headers', () => {
  const long = `./${'d/'.repeat(60)}file.txt`;
  const veryLong = `./${'x'.repeat(120)}/${'y'.repeat(110)}.txt`;
  const entries = readTar(tar([
    { path: './a/', dir: true },
    { path: './a/b.txt', data: Buffer.from('hello') },
    { path: long, data: Buffer.from('long') },
    { path: veryLong, data: Buffer.from('pax'), mode: 0o755 },
  ]));
  assert.deepEqual(entries.map((e) => e.name), ['./a/', './a/b.txt', long, veryLong]);
  assert.equal(entries[0].type, '5');
  assert.equal(entries[1].data.toString(), 'hello');
  assert.equal(entries[3].mode, 0o755);
});

test('buildDeb writes an ar archive with the three dpkg members', () => {
  const deb = buildDeb({ control: 'Package: x\nVersion: 1\n', scripts: { postinst: '#!/bin/sh\n' }, files: [{ path: './var/jb/x/y.txt', data: Buffer.from('y') }] });
  assert.equal(deb.subarray(0, 8).toString(), '!<arch>\n');
  const members = [];
  let off = 8;
  while (off < deb.length) {
    const name = deb.subarray(off, off + 16).toString().trim();
    const size = Number(deb.subarray(off + 48, off + 58).toString().trim());
    assert.equal(deb.subarray(off + 58, off + 60).toString(), '`\n');
    members.push({ name, data: deb.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  assert.deepEqual(members.map((m) => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(members[0].data.toString(), '2.0\n');
  const control = readTar(gunzipSync(members[1].data));
  assert.deepEqual(control.map((e) => e.name), ['./', './control', './postinst']);
  assert.equal(control[2].mode, 0o755);
  const data = readTar(gunzipSync(members[2].data));
  assert.deepEqual(data.map((e) => e.name), ['./', './var/', './var/jb/', './var/jb/x/', './var/jb/x/y.txt']);
});

test('ar pads odd members', () => {
  const a = ar([{ name: 'odd', data: Buffer.from('abc') }, { name: 'even', data: Buffer.from('ab') }]);
  assert.equal(a.length, 8 + 60 + 4 + 60 + 2);
});

test('templates ship with the expected files', () => {
  for (const t of ['blank', 'media', 'dashboard']) {
    const dir = new URL(`../templates/${t}/`, import.meta.url);
    const html = readFileSync(new URL('index.html', dir), 'utf8');
    assert.match(html, /\/_carpwa\/carpwa\.css/);
    assert.match(html, /\/_carpwa\/sdk\.js/);
    readFileSync(new URL('app.js', dir));
    readFileSync(new URL('style.css', dir));
  }
});

test('sync planner: diffTrees is the reference for need/remove', () => {
  const local = { 'index.html': 'a1', 'app.js': 'b2', 'img/new.png': 'c3' };
  const remote = { 'index.html': 'a1', 'app.js': 'OLD', 'gone.css': 'd4', 'img/old.png': 'e5' };
  assert.deepEqual(diffTrees(local, remote), { need: ['app.js', 'img/new.png'], remove: ['gone.css', 'img/old.png'] });
  assert.deepEqual(diffTrees(local, {}), { need: ['app.js', 'img/new.png', 'index.html'], remove: [] });
  assert.deepEqual(diffTrees({}, remote).need, []);
  assert.deepEqual(diffTrees(local, { ...local }), { need: [], remove: [] });
});

test('sync planner: planSync checks the reply against the local tree', () => {
  const hashes = { 'index.html': 'a', 'app.js': 'b' };
  assert.deepEqual(planSync(hashes, { need: ['app.js', 'app.js'], remove: ['old.js'] }), { need: ['app.js'], remove: ['old.js'] });
  assert.deepEqual(planSync(hashes, {}), { need: [], remove: [] });
  assert.deepEqual(planSync(hashes, { need: [], remove: ['index.html', 'x.js', 7] }).remove, ['x.js'], 'never deletes a file we still have');
  assert.throws(() => planSync(hashes, { need: ['../../etc/passwd'] }), /not part of the app/);
});

test('sync planner: paths and hashes', (t) => {
  assert.equal(encodeRelPath('img/a b#1.png'), 'img/a%20b%231.png');
  assert.equal(encodeRelPath('ü/ß.txt'), '%C3%BC/%C3%9F.txt');
  assert.equal(appPath('com.x.y', 'files', 'a%20b'), '/_carpwa/dev/apps/com.x.y/files/a%20b');
  const dir = makeApp(t, { id: 'com.x', name: 'X' }, {
    '.DS_Store': 'x', '.git/config': 'x', 'node_modules/m/i.js': 'x', 'sub/.hidden': 'x', 'sub/ok.js': 'hello', 'dist/old.deb': 'x', 'build/out.js': 'x', '.carpwaignore': 'build/\n',
  });
  const { hashes } = hashTree(dir);
  assert.deepEqual(Object.keys(hashes).sort(), ['carpwa.json', 'icon.png', 'index.html', 'sub/ok.js']);
  assert.equal(hashes['sub/ok.js'], createHash('sha1').update('hello').digest('hex'));
});

test('global flags are taken from anywhere on the command line', () => {
  globals.host = null; globals.verbose = false;
  assert.deepEqual(takeGlobals(['push', '--host', 'my-phone', 'dir', '--verbose']), ['push', 'dir']);
  assert.equal(globals.host, 'my-phone');
  assert.equal(globals.verbose, true);
  assert.deepEqual(takeGlobals(['--host=x', 'list']), ['list']);
  assert.equal(globals.host, 'x');
  assert.throws(() => takeGlobals(['list', '--host']), /--host needs a value/);
  globals.host = null; globals.verbose = false;
});

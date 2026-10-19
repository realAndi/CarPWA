// A stand-in for carpwad's control server (protocol.md, "Control server"),
// good enough to exercise push/dev/list/logs/remove without a phone.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { acceptUpgrade } from '../../src/websocket.js';

export async function startFakeCarpwad({ token = 'test-token', apps = [] } = {}) {
  const state = {
    token,
    // id → { files: Map<path, Buffer>, entry }
    apps: new Map(apps.map((a) => [a.id, { files: new Map(), entry: a }])),
    calls: [],
    reloads: 0,
    sockets: new Set(),
  };

  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/_carpwa/health') return json(res, 200, { ok: true, version: '1.0.0-fake' });
      if (req.headers['x-carpwa-token'] !== state.token) return json(res, 401, { error: { code: 'EPERM', message: 'bad token' } });

      if (req.method === 'GET' && url.pathname === '/_carpwa/apps') {
        return json(res, 200, [...state.apps.values()].map((a) => a.entry));
      }
      const m = /^\/_carpwa\/dev\/apps\/([^/]+)(?:\/(sync|commit|reload|files)(?:\/(.*))?)?$/.exec(url.pathname);
      if (!m) return json(res, 404, { error: { code: 'ENOTFOUND', message: 'no route' } });
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      let app = state.apps.get(id);

      if (!action && req.method === 'DELETE') {
        if (!app) return json(res, 404, { error: { code: 'ENOTFOUND', message: `no app ${id}` } });
        if (app.entry.origin === 'system') return json(res, 403, { error: { code: 'EPERM', message: 'system app' } });
        state.apps.delete(id);
        return json(res, 200, { ok: true });
      }
      if (action === 'sync' && req.method === 'POST') {
        if (app && app.entry.origin === 'system') return json(res, 403, { error: { code: 'EPERM', message: 'system app' } });
        const wanted = JSON.parse(body.toString()).files;
        const have = app ? app.files : new Map();
        const need = Object.keys(wanted).filter((p) => !have.has(p) || sha1(have.get(p)) !== wanted[p]);
        const remove = [...have.keys()].filter((p) => !(p in wanted));
        if (!app) { app = { files: new Map(), entry: null, staged: new Map() }; state.apps.set(id, app); }
        app.staged = new Map();
        return json(res, 200, { need, remove });
      }
      if (action === 'files' && req.method === 'PUT') {
        if (!app) return json(res, 404, { error: { code: 'ENOTFOUND', message: 'sync first' } });
        app.staged.set(decodeURIComponent(m[3]), body);
        return json(res, 200, { ok: true });
      }
      if (action === 'commit' && req.method === 'POST') {
        const { remove = [] } = JSON.parse(body.toString() || '{}');
        for (const [p, b] of app.staged) app.files.set(p, b);
        for (const p of remove) app.files.delete(p);
        app.staged = new Map();
        const manifest = app.files.has('carpwa.json') ? JSON.parse(app.files.get('carpwa.json').toString()) : {};
        app.entry = {
          id, name: manifest.name, version: manifest.version || '0.0.0', port: 47801,
          url: 'http://127.0.0.1:47801/index.html', origin: 'user', path: `/var/jb/var/mobile/Library/CarPWA/Apps/${id}`,
        };
        return json(res, 200, app.entry);
      }
      if (action === 'reload' && req.method === 'POST') {
        state.reloads++;
        return json(res, 200, { clients: 1 });
      }
      json(res, 405, { error: { code: 'EINVAL', message: 'bad method' } });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('devtoken') !== state.token) { socket.destroy(); return; }
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    state.sockets.add(ws);
    ws.on('close', () => state.sockets.delete(ws));
    ws.on('message', (text) => {
      const msg = JSON.parse(text);
      if (msg.module === 'dev' && msg.method === 'tailLogs') {
        ws.sendJSON({ id: msg.id, type: 'result', result: true });
        ws.sendJSON({ type: 'event', module: 'dev', event: 'log', data: { app: msg.params.app || 'com.example.any', level: 'info', args: ['hello from the phone', { n: 1 }], ts: Date.now() } });
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.port = server.address().port;
  state.close = () => new Promise((r) => { for (const s of state.sockets) s.close(); server.close(() => r()); });
  return state;
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

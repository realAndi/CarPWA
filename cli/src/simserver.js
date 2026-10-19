// `carpwa sim`: one HTTP server on 127.0.0.1 that serves the app folder like
// carpwad does, the SDK under /_carpwa/, the server bridge on /_carpwa/ws, and
// the head-unit simulator shell under /__carpwa_sim/.

import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateApp, safeJoin } from './manifest.js';
import { serveStatic, sendJSON, sendText, sendBuffer } from './static.js';
import { acceptUpgrade, rejectUpgrade } from './websocket.js';
import { SimBridge, Storage, simDataDir } from './simbridge.js';
import { sdkFile, sdkModule, sdkVersion, cliVersion, CLI_ROOT } from './sdk.js';
import { mimeType } from './mime.js';
import { watchFolder } from './watch.js';
import { readPNGInfo } from './png.js';

const SHELL_DIR = join(CLI_ROOT, 'sim');
export const SIM_VERSION = '1.0.0-sim';
const SHELL_PREFIX = '/__carpwa_sim/';

// The app's area in CSS px. The status bar is drawn next to it.
export const PRESETS = {
  standard: { width: 800, height: 480, scale: 1, physical: [170, 87], label: 'Standard · 800×480' },
  wide: { width: 1280, height: 720, scale: 1, physical: [240, 120], label: 'Wide · 1280×720' },
  ultrawide: { width: 1920, height: 720, scale: 1, physical: [322, 108], label: 'Ultrawide · 1920×720' },
  square: { width: 1024, height: 768, scale: 1, physical: [190, 128], label: 'Square · 1024×768' },
};
export const INPUTS = ['touch', 'knob', 'touchpad'];

export class SimServer {
  /**
   * @param {{ dir: string, port: number, preset: string, input: string, resetStorage?: boolean,
   *           onLog?: Function, onEvent?: Function }} options
   */
  constructor(options) {
    this.options = options;
    this.dir = options.dir;
    this.validation = validateApp(this.dir);
    this.manifest = this.validation.manifest;
    // A manifest that breaks while the simulator runs keeps the last good one
    // serving; the shell shows the errors on top.
    this.lastGood = this.manifest;
    this.shells = new Set();
    this.port = options.port;

    const storageFile = join(simDataDir(this.manifest.id), 'storage.json');
    if (options.resetStorage) Storage.reset(storageFile);
    this.bridge = new SimBridge({
      getManifest: () => this.lastGood,
      port: () => this.port,
      storage: new Storage(storageFile),
    });
    this.storageFile = storageFile;

    this.bridge.on('log', (entry) => {
      options.onLog?.({ ...entry, app: this.lastGood.id });
      this.toShells({ type: 'log', entry });
    });
    this.bridge.on('call', (entry) => this.toShells({ type: 'server-call', entry }));
    this.bridge.on('storage', (data) => this.toShells({ type: 'storage', data }));
    this.bridge.on('channel', (message) => this.toShells({ type: 'channel', message }));
    this.bridge.on('clients', (count) => this.toShells({ type: 'clients', count }));

    this.server = http.createServer((req, res) => this.request(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('clientError', (_err, socket) => socket.destroy());
  }

  /** Listens on 127.0.0.1, moving up from the requested port when it is taken. */
  listen({ strictPort = false, attempts = 20 } = {}) {
    return new Promise((resolve, reject) => {
      const tryPort = (port, left) => {
        const onError = (err) => {
          this.server.off('listening', onListening);
          if (err.code === 'EADDRINUSE' && !strictPort && left > 0) tryPort(port + 1, left - 1);
          else reject(err);
        };
        const onListening = () => {
          this.server.off('error', onError);
          this.port = this.server.address().port;
          resolve(this.port);
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(port, '127.0.0.1');
      };
      tryPort(this.options.port, attempts);
    });
  }

  startWatching() {
    this.stopWatching = watchFolder(this.dir, (files) => this.filesChanged(files));
  }

  close() {
    this.stopWatching?.();
    for (const s of this.shells) s.close(1001, 'simulator stopped');
    for (const c of this.bridge.clients) c.ws.close(1001, 'simulator stopped');
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get url() { return `http://127.0.0.1:${this.port}${SHELL_PREFIX}`; }

  // ------------------------------------------------------------- changes

  filesChanged(files) {
    let manifestChanged = files.includes('carpwa.json');
    if (!manifestChanged && this.lastGood && files.includes(this.lastGood.icon)) manifestChanged = true;
    if (manifestChanged) {
      this.validation = validateApp(this.dir);
      this.manifest = this.validation.manifest;
      if (this.manifest) {
        if (this.manifest.id !== this.lastGood.id) {
          this.validation.warnings.unshift(`"id" changed from ${this.lastGood.id} to ${this.manifest.id}; restart \`carpwa sim\` to switch storage buckets`);
        }
        this.lastGood = { ...this.manifest, id: this.lastGood.id };
      }
      this.options.onEvent?.({ type: 'manifest', validation: this.validation });
      this.toShells({ type: 'manifest', app: this.appState() });
      if (!this.manifest) return;
    }
    const reason = `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''} changed`;
    const pages = this.bridge.reload(reason);
    this.options.onEvent?.({ type: 'reload', files, pages });
    this.toShells({ type: 'reload', files, pages });
  }

  appState() {
    return {
      manifest: this.lastGood,
      errors: this.validation.errors,
      warnings: this.validation.warnings,
      iconInfo: this.iconInfo(),
    };
  }

  iconInfo() {
    const p = this.lastGood && safeJoin(this.dir, this.lastGood.icon);
    if (!p || !existsSync(p)) return null;
    const info = readPNGInfo(readFileSync(p));
    return info ? { width: info.width, height: info.height, mtime: statSync(p).mtimeMs } : null;
  }

  hello() {
    return {
      type: 'hello',
      app: this.appState(),
      options: { preset: this.options.preset, input: this.options.input },
      presets: PRESETS,
      port: this.port,
      sdkVersion: sdkVersion(),
      simVersion: SIM_VERSION,
      cliVersion: cliVersion(),
      storage: this.bridge.storage.data,
      storageFile: this.storageFile,
      clients: this.bridge.clients.size,
      dir: this.dir,
    };
  }

  toShells(msg) {
    const text = JSON.stringify(msg);
    for (const s of this.shells) s.send(text);
  }

  // -------------------------------------------------------------- HTTP

  hostOK(req) {
    const host = String(req.headers.host || '');
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  // Browsers always send Origin on WebSockets: a page from another site is
  // refused. Tools (Node scripts, curl) send none and are let in.
  originOK(req) {
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  request(req, res) {
    // DNS-rebinding guard: only answer requests addressed to this machine.
    if (!this.hostOK(req)) return sendText(res, 403, 'carpwa sim only answers http://127.0.0.1 and http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (path === '/__carpwa_sim') return redirect(res, SHELL_PREFIX);
    if (path.startsWith(SHELL_PREFIX)) return this.shellRequest(req, res, path.slice(SHELL_PREFIX.length));

    const cache = { 'Cache-Control': 'no-cache' };
    switch (path) {
      case '/_carpwa/sdk.js': return sendBuffer(res, sdkFile('carpwa.js'), 'text/javascript; charset=utf-8', cache);
      case '/_carpwa/sdk.mjs': return sendBuffer(res, sdkModule(), 'text/javascript; charset=utf-8', cache);
      case '/_carpwa/carpwa.css': return sendBuffer(res, sdkFile('carpwa.css'), 'text/css; charset=utf-8', cache);
      case '/_carpwa/carpwa.d.ts': return sendBuffer(res, sdkFile('carpwa.d.ts'), 'text/plain; charset=utf-8', cache);
      case '/_carpwa/manifest': return sendJSON(res, 200, this.lastGood, cache);
      case '/_carpwa/health': return sendJSON(res, 200, { ok: true, version: SIM_VERSION, simulator: true }, cache);
    }
    if (path.startsWith('/_carpwa/')) return sendText(res, 404, `Not found: ${path}`);

    serveStatic(req, res, this.dir, this.lastGood, { headers: cache });
  }

  shellRequest(req, res, rel) {
    if (rel === '' || rel === 'index.html') rel = 'index.html';
    if (rel === 'app-icon') {
      const p = safeJoin(this.dir, this.lastGood.icon);
      // The shell versions this URL with the icon's mtime, so it may be cached.
      if (p && existsSync(p)) return sendBuffer(res, readFileSync(p), 'image/png', { 'Cache-Control': 'private, max-age=86400' });
      return sendText(res, 404, 'no icon');
    }
    if (rel === 'api/state') return sendJSON(res, 200, this.hello());
    if (!/^[a-z0-9_-]+\.(html|js|css|svg|png)$/i.test(rel)) return sendText(res, 404, 'Not found');
    const file = join(SHELL_DIR, rel);
    if (!existsSync(file)) return sendText(res, 404, 'Not found');
    sendBuffer(res, readFileSync(file), mimeType(file), {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (!this.hostOK(req) || !this.originOK(req)) return rejectUpgrade(socket, 403, 'Forbidden');

    if (url.pathname === '/_carpwa/ws') {
      const ws = acceptUpgrade(req, socket, head);
      if (ws) this.bridge.attach(ws);
      return;
    }
    if (url.pathname === SHELL_PREFIX + 'ws') {
      const ws = acceptUpgrade(req, socket, head);
      if (!ws) return;
      this.shells.add(ws);
      ws.on('close', () => this.shells.delete(ws));
      ws.on('message', (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        this.shellMessage(ws, msg);
      });
      ws.sendJSON(this.hello());
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  }

  shellMessage(ws, msg) {
    const reply = (value) => ws.sendJSON({ type: 'reply', rid: msg.rid, ...value });
    try {
      switch (msg.type) {
        case 'storage.set': this.bridge.shellStorage('set', String(msg.key), msg.value); break;
        case 'storage.remove': this.bridge.shellStorage('remove', String(msg.key)); break;
        case 'storage.clear': this.bridge.shellStorage('clear'); break;
        case 'channel.join': this.bridge.devChannels.add(String(msg.channel)); break;
        case 'channel.leave': this.bridge.devChannels.delete(String(msg.channel)); break;
        case 'channel.publish': {
          const from = msg.from === 'native' ? 'native' : 'dev';
          const n = this.bridge.publish(String(msg.channel), msg.data === undefined ? null : msg.data, from);
          if (msg.rid) reply({ ok: true, result: n });
          return;
        }
        case 'log':
          // Car-bridge activity the shell wants mirrored in the terminal (system.log, crashes).
          this.options.onLog?.({ level: msg.level || 'info', args: [msg.message], ts: Date.now(), source: msg.source });
          break;
        case 'revalidate':
          this.filesChanged(['carpwa.json']);
          break;
        default:
          return;
      }
      if (msg.rid) reply({ ok: true });
    } catch (e) {
      if (msg.rid) reply({ ok: false, error: { code: e.code || 'EINTERNAL', message: e.message } });
    }
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// The simulator's stand-in for carpwad's per-app server bridge: the `storage`,
// `channel`, `net`, `app` and `dev` modules over /_carpwa/ws, with the same
// envelopes, error codes and permission checks as the phone
// (docs/reference/protocol.md, "Server modules").

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { hostAllowed } from './manifest.js';
import { isTextual } from './mime.js';

const STORAGE_CAP = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function simDataDir(appId) {
  return join(process.env.CARPWA_HOME || join(homedir(), '.carpwa'), 'sim', appId);
}

/** Per-app JSON storage, persisted between simulator runs. */
export class Storage {
  constructor(file) {
    this.file = file;
    this.data = {};
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed;
      } catch { /* corrupt file: start empty */ }
    }
  }

  size(data = this.data) { return Buffer.byteLength(JSON.stringify(data)); }

  set(key, value) {
    const next = { ...this.data, [key]: value };
    if (this.size(next) > STORAGE_CAP) throw new BridgeError('EINVAL', 'storage is full (5 MiB per app)');
    this.data = next;
    this.save();
  }

  remove(key) {
    delete this.data[key];
    this.save();
  }

  clear() {
    this.data = {};
    this.save();
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  static reset(file) {
    rmSync(file, { force: true });
  }
}

/**
 * Events: 'log' ({ level, args, ts }), 'call' ({ module, method, params, ok, result?, error?, ms }),
 * 'storage' (data), 'channel' ({ channel, data, from }), 'clients' (count).
 */
export class SimBridge extends EventEmitter {
  /**
   * @param {{ getManifest: () => object, port: () => number, storage: Storage }} ctx
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.clients = new Set();
    // Channels the simulator shell joined as "dev".
    this.devChannels = new Set();
  }

  get manifest() { return this.ctx.getManifest(); }

  /** @param {import('./websocket.js').WebSocketConnection} ws */
  attach(ws) {
    const client = { ws, channels: new Set() };
    this.clients.add(client);
    this.emit('clients', this.clients.size);
    ws.on('message', (text, binary) => {
      if (binary) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || msg.type !== 'call' || typeof msg.id !== 'number') return;
      this.handle(client, msg);
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.emit('clients', this.clients.size);
    });
  }

  async handle(client, msg) {
    const started = Date.now();
    const { id, module, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    try {
      const result = await this.dispatch(client, String(module), String(method), params);
      client.ws.sendJSON({ id, type: 'result', result: result === undefined ? null : result });
      if (module !== 'dev') this.emit('call', { module, method, params, ok: true, result: summarize(result), ms: Date.now() - started });
    } catch (e) {
      const error = e instanceof BridgeError
        ? { code: e.code, message: e.message }
        : { code: 'EINTERNAL', message: (e && e.message) || String(e) };
      client.ws.sendJSON({ id, type: 'error', error });
      this.emit('call', { module, method, params, ok: false, error, ms: Date.now() - started });
    }
  }

  async dispatch(client, module, method, params) {
    const m = this.manifest;
    switch (`${module}.${method}`) {
      case 'app.info':
        return {
          id: m.id, name: m.name, version: m.version, port: this.ctx.port(),
          permissions: m.permissions, origin: 'user',
        };
      case 'app.list':
        return [this.appEntry()];

      case 'storage.get':
        requireKey(params);
        return Object.prototype.hasOwnProperty.call(this.storage.data, params.key) ? this.storage.data[params.key] : null;
      case 'storage.set': {
        requireKey(params);
        const value = params.value === undefined ? null : params.value;
        this.storage.set(params.key, value);
        this.broadcastStorage({ key: params.key, value }, client);
        return true;
      }
      case 'storage.remove':
        requireKey(params);
        this.storage.remove(params.key);
        this.broadcastStorage({ key: params.key, value: null }, client);
        return true;
      case 'storage.keys':
        return Object.keys(this.storage.data);
      case 'storage.getAll':
        return this.storage.data;
      case 'storage.clear':
        this.storage.clear();
        this.broadcastStorage({ key: null, value: null }, client);
        return true;

      case 'channel.join':
        client.channels.add(requireChannel(params));
        return true;
      case 'channel.leave':
        client.channels.delete(requireChannel(params));
        return true;
      case 'channel.publish':
        return this.publish(requireChannel(params), params.data === undefined ? null : params.data, m.id, client);

      case 'net.fetch':
        if (!m.permissions.includes('network')) throw new BridgeError('EPERM', 'network not granted');
        return this.fetch(params);

      case 'dev.log': {
        const level = ['log', 'info', 'warn', 'error', 'debug'].includes(params.level) ? params.level : 'log';
        this.emit('log', { level, args: Array.isArray(params.args) ? params.args : [params.args], ts: Number(params.ts) || Date.now() });
        return true;
      }
      case 'dev.tailLogs':
      case 'dev.untailLogs':
        throw new BridgeError('EPERM', `${module}.${method} needs a developer-token connection`);
    }
    if (!['app', 'storage', 'channel', 'net', 'dev'].includes(module)) throw new BridgeError('ENOTFOUND', `no such module ${module}`);
    throw new BridgeError('ENOTFOUND', `no such method ${module}.${method}`);
  }

  appEntry() {
    const m = this.manifest;
    const port = this.ctx.port();
    return { id: m.id, name: m.name, version: m.version, port, url: `http://127.0.0.1:${port}/${m.start_url}` };
  }

  /** Sends dev.reload to every page connection; returns how many got it. */
  reload(reason) {
    for (const c of this.clients) c.ws.sendJSON({ type: 'event', module: 'dev', event: 'reload', data: { reason } });
    return this.clients.size;
  }

  broadcastStorage(change, except = null) {
    for (const c of this.clients) {
      if (c !== except) c.ws.sendJSON({ type: 'event', module: 'storage', event: 'changed', data: change });
    }
    this.emit('storage', this.storage.data);
  }

  /** Delivers to every other joined connection; returns the receiver count. */
  publish(channel, data, from, sender = null) {
    let n = 0;
    const message = { channel, data, from };
    for (const c of this.clients) {
      if (c === sender || !c.channels.has(channel)) continue;
      c.ws.sendJSON({ type: 'event', module: 'channel', event: 'message', data: message });
      n++;
    }
    if (this.devChannels.has(channel) && from !== 'dev') n++;
    this.emit('channel', message);
    return n;
  }

  /** Called by the shell: storage edits from the inspector reach pages as storage.changed. */
  shellStorage(op, key, value) {
    if (op === 'set') {
      this.storage.set(key, value === undefined ? null : value);
      this.broadcastStorage({ key, value });
    } else if (op === 'remove') {
      this.storage.remove(key);
      this.broadcastStorage({ key, value: null });
    } else if (op === 'clear') {
      this.storage.clear();
      this.broadcastStorage({ key: null, value: null });
    }
  }

  async fetch(params) {
    const allow = this.manifest.network.allow;
    if (typeof params.url !== 'string') throw new BridgeError('EINVAL', 'net.fetch needs a url');
    let url;
    try { url = new URL(params.url); } catch { throw new BridgeError('EINVAL', `invalid URL ${params.url}`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BridgeError('EINVAL', 'net.fetch only supports http and https');

    const method = String(params.method || 'GET').toUpperCase();
    const headers = params.headers && typeof params.headers === 'object' ? { ...params.headers } : {};
    let body;
    if (params.body != null && method !== 'GET' && method !== 'HEAD') {
      body = params.bodyEncoding === 'base64' ? Buffer.from(String(params.body), 'base64') : String(params.body);
    }
    const timeout = Math.max(1, Math.min(300, Number(params.timeout) || 30)) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      for (let hop = 0; ; hop++) {
        if (!hostAllowed(url.hostname, allow)) {
          throw new BridgeError('EPERM', `${url.hostname} is not in network.allow`);
        }
        const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
          url = new URL(location, url);
          if (res.status === 303) { body = undefined; }
          await res.arrayBuffer().catch(() => {});
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get('content-type') || '';
        const out = {};
        res.headers.forEach((v, k) => { out[k] = v; });
        const text = isTextual(type);
        return {
          status: res.status,
          statusText: res.statusText,
          headers: out,
          url: url.toString(),
          body: text ? buf.toString('utf8') : buf.toString('base64'),
          bodyEncoding: text ? 'text' : 'base64',
        };
      }
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      if (e && e.name === 'AbortError') throw new BridgeError('ETIMEOUT', `net.fetch ${url} timed out`);
      throw new BridgeError('EUNAVAILABLE', `net.fetch ${url}: ${(e && e.cause && e.cause.message) || (e && e.message) || e}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireKey(params) {
  if (typeof params.key !== 'string' || !params.key) throw new BridgeError('EINVAL', 'key must be a non-empty string');
}

function requireChannel(params) {
  if (typeof params.channel !== 'string' || !params.channel) throw new BridgeError('EINVAL', 'channel must be a non-empty string');
  return params.channel;
}

// Keeps the inspector's call log small: long strings and big objects are cut.
function summarize(value) {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return null;
    if (s.length <= 2000) return value;
    return s.slice(0, 2000) + '…';
  } catch {
    return String(value);
  }
}

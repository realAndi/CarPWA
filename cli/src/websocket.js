// RFC 6455 WebSockets on Node built-ins: the server side of an HTTP upgrade
// (simulator) and a small client (talking to carpwad through an SSH tunnel).
// Text and binary messages, fragmentation, ping/pong and close; no extensions.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ client?: boolean }} options client connections mask outgoing frames
   */
  constructor(socket, { client = false } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._fragments = null;
    this._fragmentOpcode = 0;
    this._fragmentSize = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed(1006, ''));
    socket.on('error', () => this._closed(1006, ''));
  }

  send(data) {
    if (!this.open) return false;
    const isText = typeof data === 'string';
    this._frame(isText ? 1 : 2, isText ? Buffer.from(data, 'utf8') : Buffer.from(data));
    return true;
  }

  sendJSON(value) { return this.send(JSON.stringify(value)); }

  ping(data = Buffer.alloc(0)) { if (this.open) this._frame(9, data); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._frame(8, body);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._closed(code, reason);
  }

  _closed(code, reason) {
    if (this._didClose) return;
    this._didClose = true;
    this.open = false;
    this.emit('close', code, reason);
  }

  _frame(opcode, payload) {
    const len = payload.length;
    const mask = this.client ? randomBytes(4) : null;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    if (mask) {
      header[1] |= 0x80;
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      payload = Buffer.concat([mask, masked]);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { /* socket gone */ }
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this.open) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this._fail(1009, 'message too big');
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE) return this._fail(1009, 'message too big');
      if (!this.client && !masked) return this._fail(1002, 'client frames must be masked');
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(maskOff, maskOff + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this._buf = buf.subarray(off + len);
      this._handleFrame(fin, opcode, payload);
      if (!this.open) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (this.open) {
        this._frame(8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this.open = false;
        this.socket.end();
      }
      this._closed(code, reason);
      return;
    }
    if (opcode === 9) { this._frame(10, payload); return; }
    if (opcode === 10) { this.emit('pong', payload); return; }

    if (opcode === 0) {
      if (!this._fragments) return this._fail(1002, 'unexpected continuation frame');
      this._fragments.push(payload);
      this._fragmentSize += payload.length;
      if (this._fragmentSize > MAX_MESSAGE) return this._fail(1009, 'message too big');
      if (!fin) return;
      payload = Buffer.concat(this._fragments);
      opcode = this._fragmentOpcode;
      this._fragments = null;
    } else if (opcode === 1 || opcode === 2) {
      if (this._fragments) return this._fail(1002, 'expected a continuation frame');
      if (!fin) {
        this._fragments = [payload];
        this._fragmentOpcode = opcode;
        this._fragmentSize = payload.length;
        return;
      }
    } else {
      return this._fail(1002, `unknown opcode ${opcode}`);
    }
    this.emit('message', opcode === 1 ? payload.toString('utf8') : payload, opcode === 2);
  }

  _fail(code, reason) {
    this.close(code, reason);
    this._buf = Buffer.alloc(0);
  }
}

/**
 * Completes a server-side upgrade. Returns null (after answering 400) when the
 * request is not a WebSocket handshake.
 * @param {http.IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  const ws = new WebSocketConnection(socket);
  // Bytes that arrived with the handshake are parsed once the caller has
  // attached its listeners.
  if (head && head.length) setImmediate(() => ws._onData(head));
  return ws;
}

export function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* ignore */ }
  socket.destroy();
}

/**
 * Opens a client connection.
 * @param {string} url ws:// URL
 * @param {{ headers?: Record<string,string>, timeout?: number }} [options]
 * @returns {Promise<WebSocketConnection>}
 */
export function connectWebSocket(url, { headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'ws:') { reject(new Error(`only ws:// URLs are supported, got ${u.protocol}`)); return; }
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
      timeout,
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      const ws = new WebSocketConnection(socket, { client: true });
      if (head && head.length) setImmediate(() => ws._onData(head));
      resolve(ws);
    });
    req.on('response', (res) => {
      reject(new Error(`WebSocket handshake refused: HTTP ${res.statusCode}`));
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('WebSocket connect timed out')));
    req.on('error', reject);
    req.end();
  });
}

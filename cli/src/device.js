// Talking to carpwad on the phone, always through the system `ssh` binary.
// The control server only listens on the phone's 127.0.0.1:47800, so every
// device command finds the jailbreak root, reads the dev token, and forwards
// a local port to the control server (protocol.md, "Control server").

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { connectWebSocket } from './websocket.js';
import { CliError, globals, verbose } from './log.js';

export const CONTROL_PORT = 47800;
export const CARPWA_PACKAGE = 'com.andi.carpwa';

export function sshHost() {
  return globals.host || process.env.CARPWA_HOST || 'iphone';
}

const sshBinary = () => process.env.CARPWA_SSH || 'ssh';
const BASE_OPTIONS = ['-o', 'ConnectTimeout=10'];

// --------------------------------------------------------------- children

// Tunnels must never outlive the CLI, whatever ends it.
const children = new Set();

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  installCleanup();
  return child;
}

function killChildren() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', killChildren);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, function onSignal() {
      killChildren();
      // Commands that stop gracefully (dev, logs) add their own listener.
      if (process.listenerCount(sig) <= 1) process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

// -------------------------------------------------------------------- ssh

/**
 * Runs one command on the phone.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runSSH(command, { host = sshHost(), timeout = 30000 } = {}) {
  const args = [...BASE_OPTIONS, host, command];
  verbose(`$ ${sshBinary()} ${args.map(quote).join(' ')}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = track(spawn(sshBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      reject(sshMissing(e));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { stderr += `timed out after ${timeout / 1000}s`; child.kill(); }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(sshMissing(e)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stderr.trim()) verbose(stderr.trim());
      resolve({ code, stdout, stderr });
    });
  });
}

/** Like runSSH, but resolves with trimmed stdout and throws a one-line error on failure. */
export async function remote(command, options = {}) {
  const host = options.host || sshHost();
  const r = await runSSH(command, options);
  if (r.code === 0) return r.stdout.trim();
  throw sshError(host, command, r);
}

export function sshError(host, command, r) {
  const detail = lastLine(r.stderr);
  if (r.code === 255 || r.code === null) {
    return new CliError(`cannot reach ${host} over SSH${detail ? `: ${detail}` : ''} (set --host or CARPWA_HOST; \`carpwa doctor\` checks the setup)`);
  }
  return new CliError(`\`${command}\` failed on ${host} (exit ${r.code})${detail ? `: ${detail}` : ''}`);
}

function sshMissing(e) {
  return new CliError(e.code === 'ENOENT' ? 'ssh is not installed or not on PATH' : `could not start ssh: ${e.message}`);
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------ jbroot/token

/** "/var/jb" on rootless jailbreaks, "" on rootful ones. */
export async function detectJbroot(host = sshHost()) {
  const out = await remote('test -d /var/jb && echo /var/jb || echo', { host });
  return out === '/var/jb' ? '/var/jb' : '';
}

export function carpwaDataPath(jbroot, ...rest) {
  return [`${jbroot}/var/mobile/Library/CarPWA`, ...rest].join('/');
}

export async function readToken(host, jbroot) {
  const path = carpwaDataPath(jbroot, 'dev-token');
  const r = await runSSH(`cat ${path}`, { host });
  const token = r.stdout.trim();
  if (r.code === 0 && token) return token;
  if (r.code === 255 || r.code === null) throw sshError(host, `cat ${path}`, r);
  throw new CliError(`cannot read the dev token at ${path} on ${host}; is CarPWA installed and has carpwad started once? (\`carpwa doctor\`)`);
}

// ----------------------------------------------------------------- tunnel

export function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (e) => {
      if (preferred) freePort(0).then(resolve, reject);
      else reject(e);
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * `ssh -N -o ExitOnForwardFailure=yes -L <local>:127.0.0.1:<remotePort> <host>`,
 * resolved once the local port accepts connections.
 * @returns {Promise<{ port: number, child: import('node:child_process').ChildProcess, close: () => void }>}
 */
export async function openTunnel(remotePort, { host = sshHost(), localPort } = {}) {
  const port = localPort || await freePort();
  const args = [
    '-N', ...BASE_OPTIONS,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `${port}:127.0.0.1:${remotePort}`,
    host,
  ];
  verbose(`$ ${sshBinary()} ${args.join(' ')}`);
  let child;
  try {
    child = track(spawn(sshBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] }));
  } catch (e) {
    throw sshMissing(e);
  }
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  let exited = null;
  child.on('error', (e) => { exited = sshMissing(e); });
  child.on('exit', (code, signal) => { if (exited === null) exited = code ?? signal; });

  const deadline = Date.now() + 60000;   // room for a password prompt
  while (!(await canConnect(port))) {
    if (exited !== null) {
      if (exited instanceof Error) throw exited;
      throw sshError(host, `ssh -L ${port}:127.0.0.1:${remotePort}`, { code: 255, stderr });
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new CliError(`the SSH tunnel to ${host} did not come up within 60s`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  verbose(`tunnel 127.0.0.1:${port} → ${host}:127.0.0.1:${remotePort}`);
  return {
    port,
    child,
    close() { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

// ----------------------------------------------------------------- device

export class Device {
  constructor({ host, jbroot, token, tunnel }) {
    this.host = host;
    this.jbroot = jbroot;
    this.token = token;
    this.tunnel = tunnel;
    this.port = tunnel.port;
    this.extra = [];         // more tunnels opened for this device (app ports)
    this.onClose = null;
    tunnel.child.on('exit', () => {
      if (this.closed) return;
      this.closed = true;
      for (const t of this.extra) t.close();
      this.onClose?.();
    });
  }

  get label() { return this.host; }

  /** Raw request against the control server. Resolves { status, body: Buffer, json }. */
  request(method, path, body, { timeout = 60000 } = {}) {
    verbose(`${method} ${path}`);
    return new Promise((resolve, reject) => {
      let payload = null;
      const headers = { 'X-CarPWA-Token': this.token, Host: `127.0.0.1:${CONTROL_PORT}` };
      if (Buffer.isBuffer(body)) {
        payload = body;
        headers['Content-Type'] = 'application/octet-stream';
      } else if (body !== undefined) {
        payload = Buffer.from(JSON.stringify(body));
        headers['Content-Type'] = 'application/json';
      }
      if (payload) headers['Content-Length'] = payload.length;
      const req = http.request({ host: '127.0.0.1', port: this.port, method, path, headers, timeout }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json;
          try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { json = undefined; }
          verbose(`→ ${res.statusCode} ${buf.length} bytes`);
          resolve({ status: res.statusCode, body: buf, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', (e) => reject(new CliError(`carpwad on ${this.host} did not answer ${method} ${path}: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** JSON call that throws a one-line error on anything but 2xx. */
  async call(method, path, body, options) {
    const res = await this.request(method, path, body, options);
    if (res.status >= 200 && res.status < 300) return res.json;
    if (res.status === 401) throw tokenError(this.host);
    const e = res.json && (res.json.error || res.json);
    const msg = (e && (e.message || e.code)) || lastLine(res.body.toString('utf8')) || `HTTP ${res.status}`;
    const err = new CliError(`${method} ${path}: ${msg} (HTTP ${res.status})`);
    err.status = res.status;
    err.code = e && e.code;
    throw err;
  }

  /** The control WebSocket (`/_carpwa/ws?devtoken=`) for channels and log tailing. */
  socket() {
    verbose('WebSocket /_carpwa/ws?devtoken=…');
    return connectWebSocket(`ws://127.0.0.1:${this.port}/_carpwa/ws?devtoken=${encodeURIComponent(this.token)}`, {
      headers: { Origin: `http://127.0.0.1:${CONTROL_PORT}`, Host: `127.0.0.1:${CONTROL_PORT}` },
    });
  }

  /** Forwards another phone port (an app's server) through SSH. */
  async forward(remotePort, localPort) {
    const t = await openTunnel(remotePort, { host: this.host, localPort });
    this.extra.push(t);
    return t;
  }

  close() {
    this.closed = true;
    for (const t of this.extra) t.close();
    this.tunnel.close();
  }
}

function tokenError(host) {
  return new CliError(`carpwad on ${host} refused the dev token (HTTP 401); it changes when CarPWA is reinstalled, so just retry`);
}

/** jbroot → dev token → tunnel → /_carpwa/health → a token check. */
export async function openDevice({ host = sshHost() } = {}) {
  const jbroot = await detectJbroot(host);
  const token = await readToken(host, jbroot);
  const tunnel = await openTunnel(CONTROL_PORT, { host });
  const device = new Device({ host, jbroot, token, tunnel });
  try {
    const health = await device.request('GET', '/_carpwa/health', undefined, { timeout: 10000 });
    if (health.status !== 200 || !health.json || !health.json.ok) {
      throw new CliError(`carpwad is not answering on ${host} (127.0.0.1:${CONTROL_PORT}); run \`carpwa doctor\``);
    }
    device.health = health.json;
    // A 401 here means a bad token; later errors are about the request itself.
    const probe = await device.request('GET', '/_carpwa/apps', undefined, { timeout: 10000 });
    if (probe.status === 401) throw tokenError(host);
    device.apps = Array.isArray(probe.json) ? probe.json : [];
  } catch (e) {
    device.close();
    if (e instanceof CliError) throw e;
    throw new CliError(`carpwad is not answering on ${host}: ${e.message}`);
  }
  return device;
}

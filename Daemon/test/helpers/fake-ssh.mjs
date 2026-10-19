#!/usr/bin/env node
// Stands in for `ssh` when the carpwa CLI talks to a carpwad running on this
// Mac (CARPWA_SSH points here). Commands run locally with /var/jb/ rewritten
// to FAKE_JBROOT; `-L <local>:127.0.0.1:<remote>` forwards are served here,
// with the phone's 47800+n mapped to FAKE_BASE_PORT+n.

import net from 'node:net';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let forward = null;
let i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '-p' || a === '-i') { i++; continue; }
  if (a === '-L') { forward = args[++i]; continue; }
  if (a.startsWith('-')) continue;
  break;   // the host
}
const command = args.slice(i + 1).join(' ');
const jbroot = process.env.FAKE_JBROOT;
const base = Number(process.env.FAKE_BASE_PORT);

function mapPort(port) {
  return port >= 47800 && port < 48800 ? base + (port - 47800) : port;
}

if (forward) {
  const [localPort, , remotePort] = forward.split(':');
  const target = mapPort(Number(remotePort));
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  server.on('error', (e) => {
    process.stderr.write(`bind [127.0.0.1]:${localPort}: ${e.message}\n`);
    process.exit(255);
  });
  server.listen(Number(localPort), '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
} else {
  const local = command.replaceAll('test -d /var/jb', 'true').replaceAll('/var/jb/', `${jbroot}/`);
  const child = spawn('/bin/sh', ['-c', local], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
}

#!/usr/bin/env node
// Stands in for the system `ssh` in tests (CARPWA_SSH points here). It
// understands exactly what the CLI runs:
//   ssh [-o …] <host> 'test -d /var/jb && echo /var/jb || echo'
//   ssh [-o …] <host> cat <jbroot>/var/mobile/Library/CarPWA/dev-token
//   ssh [-o …] <host> 'PATH=… dpkg -s com.andi.carpwa' | 'sw_vers …' | true
//   ssh -N [-o …] -L <local>:127.0.0.1:<remote> <host>
// Remote port 47800 goes to FAKE_CARPWAD_PORT, anything else to FAKE_APP_PORT.

import net from 'node:net';
import { appendFileSync } from 'node:fs';

// Executed directly by an older `node --test <dir>` runner: nothing to do.
if (!process.env.FAKE_CARPWAD_PORT) process.exit(0);

const args = process.argv.slice(2);
let forward = null;
let host = null;
let i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '-p' || a === '-i') { i++; continue; }
  if (a === '-L') { forward = args[++i]; continue; }
  if (a.startsWith('-')) continue;
  host = a;
  break;
}
const command = args.slice(i + 1).join(' ');
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ host, forward, command }) + '\n');

if (process.env.FAKE_SSH_FAIL) {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`);
  process.exit(255);
}

const jbroot = process.env.FAKE_JBROOT ?? '/var/jb';

if (forward) {
  const [localPort, , remotePort] = forward.split(':');
  const target = Number(remotePort) === 47800 ? Number(process.env.FAKE_CARPWAD_PORT) : Number(process.env.FAKE_APP_PORT || 0);
  const server = net.createServer((client) => {
    if (!target) { client.destroy(); return; }
    const upstream = net.connect(target, '127.0.0.1');
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  server.on('error', (e) => {
    process.stderr.write(`bind [127.0.0.1]:${localPort}: ${e.code === 'EADDRINUSE' ? 'Address already in use' : e.message}\n`);
    process.exit(255);
  });
  server.listen(Number(localPort), '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
} else if (command === 'true') {
  process.exit(0);
} else if (command.startsWith('test -d /var/jb')) {
  process.stdout.write(`${jbroot}\n`);
} else if (command.startsWith('cat ') && command.endsWith('/dev-token')) {
  const expected = `cat ${jbroot}/var/mobile/Library/CarPWA/dev-token`;
  if (command !== expected || !process.env.FAKE_TOKEN) {
    process.stderr.write(`cat: ${command.slice(4)}: No such file or directory\n`);
    process.exit(1);
  }
  process.stdout.write(`${process.env.FAKE_TOKEN}\n`);
} else if (command.includes('dpkg -s com.andi.carpwa')) {
  if (process.env.FAKE_NO_CARPWA) {
    process.stderr.write("dpkg-query: package 'com.andi.carpwa' is not installed and no information is available\n");
    process.exit(1);
  }
  process.stdout.write('Package: com.andi.carpwa\nStatus: install ok installed\nVersion: 1.0.0\nArchitecture: iphoneos-arm64\n');
} else if (command.startsWith('sw_vers')) {
  process.stdout.write('16.5\n');
} else {
  process.stderr.write(`sh: ${command.split(' ')[0]}: command not found\n`);
  process.exit(127);
}

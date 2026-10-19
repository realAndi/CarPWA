// Device commands against a fake carpwad, reached through a fake `ssh`
// (test/helpers/fake-ssh.js) so the real tunnel code runs end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeCarpwad } from './helpers/fake-carpwad.js';
import { tempDir, runCLI, startCLI, CLI_ROOT } from './helpers/util.js';

const FAKE_SSH = join(CLI_ROOT, 'test', 'helpers', 'fake-ssh.js');

async function setup(t, apps) {
  const daemon = await startFakeCarpwad({ apps });
  t.after(() => daemon.close());
  const root = tempDir(t);
  const dir = join(root, 'app');
  const created = await runCLI(['create', dir, '--template', 'media', '--id', 'com.test.push', '--name', 'Pushy']);
  assert.equal(created.code, 0, created.stderr);
  const sshLog = join(root, 'ssh.log');
  const env = {
    CARPWA_HOME: join(root, 'home'),
    CARPWA_SSH: FAKE_SSH,
    CARPWA_HOST: 'phone',
    FAKE_CARPWAD_PORT: String(daemon.port),
    FAKE_TOKEN: daemon.token,
    FAKE_SSH_LOG: sshLog,
  };
  const sshCalls = () => readFileSync(sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { daemon, dir, env, sshCalls };
}

test('push: jbroot, token and tunnel over ssh, then the sync protocol', async (t) => {
  const { daemon, dir, env, sshCalls } = await setup(t);

  let r = await runCLI(['push', dir], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Pushed Pushy 1\.0\.0 to phone: 6 of 6 files uploaded/);
  assert.match(r.stdout, /port\s+47801/);
  assert.match(r.stdout, /origin\s+user/);
  const calls = sshCalls();
  assert.equal(calls[0].command, 'test -d /var/jb && echo /var/jb || echo');
  assert.equal(calls[1].command, 'cat /var/jb/var/mobile/Library/CarPWA/dev-token');
  assert.match(calls[2].forward, /^\d+:127\.0\.0\.1:47800$/);
  assert.equal(calls[2].command, '');
  assert.ok(calls.every((c) => c.host === 'phone'));

  const app = daemon.apps.get('com.test.push');
  assert.deepEqual([...app.files.keys()].sort(), ['README.md', 'app.js', 'carpwa.json', 'icon.png', 'index.html', 'style.css']);
  assert.deepEqual(app.files.get('app.js'), readFileSync(join(dir, 'app.js')));
  assert.equal(daemon.reloads, 0, 'push does not reload unless asked');

  r = await runCLI(['push', dir, '--reload'], { env });
  assert.match(r.stdout, /all 6 files already up to date/);
  assert.match(r.stdout, /reloaded\s+1 page/);

  writeFileSync(join(dir, 'app.js'), '// new\n');
  writeFileSync(join(dir, 'extra file.txt'), 'x');
  writeFileSync(join(dir, '.DS_Store'), 'x');
  unlinkSync(join(dir, 'style.css'));
  r = await runCLI(['push', dir, '--host', 'other-phone'], { env });
  assert.match(r.stdout, /to other-phone: 2 of 6 files uploaded .*1 removed/);
  assert.deepEqual([...app.files.keys()].sort(), ['README.md', 'app.js', 'carpwa.json', 'extra file.txt', 'icon.png', 'index.html']);
  assert.ok(daemon.calls.includes('PUT /_carpwa/dev/apps/com.test.push/files/extra%20file.txt'));
  assert.equal(sshCalls().at(-1).host, 'other-phone');
});

test('push refuses an invalid app before touching the phone', async (t) => {
  const { daemon, dir, env } = await setup(t);
  writeFileSync(join(dir, 'carpwa.json'), '{"id": "com.test.push"}');
  const r = await runCLI(['push', dir], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"name" is required/);
  assert.deepEqual(daemon.calls, []);
});

test('list, reload, remove and open', async (t) => {
  const { dir, env, daemon } = await setup(t, [{ id: 'com.sys.app', name: 'Sys', version: '1', port: 47802, url: 'x', origin: 'system' }]);
  assert.equal((await runCLI(['push', dir], { env })).code, 0);

  let r = await runCLI(['list'], { env });
  assert.match(r.stdout, /ID\s+NAME\s+VERSION\s+PORT\s+ORIGIN/);
  assert.match(r.stdout, /com\.test\.push\s+Pushy\s+1\.0\.0\s+47801\s+user/);
  assert.match(r.stdout, /com\.sys\.app\s+Sys\s+1\s+47802\s+system/);
  assert.equal(JSON.parse((await runCLI(['list', '--json'], { env })).stdout).length, 2);

  r = await runCLI(['reload', 'com.test.push'], { env });
  assert.match(r.stdout, /Reloaded com\.test\.push: 1 page/);
  assert.equal(daemon.reloads, 1);

  r = await runCLI(['remove', 'com.sys.app'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /installed from a package \(origin "system"\)/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one-line error');
  assert.ok(!daemon.calls.includes('DELETE /_carpwa/dev/apps/com.sys.app'));

  r = await runCLI(['remove', 'com.test.push'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!daemon.apps.has('com.test.push'));
  r = await runCLI(['remove', 'com.test.push'], { env });
  assert.match(r.stderr, /not on the phone/);

  r = await runCLI(['open', 'com.test.push'], { env });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /not supported over SSH in v1.*CarPlay home screen/);
});

test('one-line errors: SSH down, no token, wrong token; rootful paths', async (t) => {
  const { dir, env, sshCalls } = await setup(t);
  let r = await runCLI(['push', dir], { env: { ...env, FAKE_SSH_FAIL: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot reach phone over SSH: ssh: connect to host phone port 22: Connection refused/);
  assert.equal(r.stderr.trim().split('\n').length, 1);

  r = await runCLI(['push', dir], { env: { ...env, FAKE_TOKEN: '' } });
  assert.match(r.stderr, /cannot read the dev token at \/var\/jb\/var\/mobile\/Library\/CarPWA\/dev-token/);

  r = await runCLI(['list'], { env: { ...env, FAKE_TOKEN: 'wrong' } });
  assert.match(r.stderr, /refused the dev token \(HTTP 401\)/);

  r = await runCLI(['list'], { env: { ...env, FAKE_JBROOT: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sshCalls().filter((c) => c.command.startsWith('cat ')).at(-1).command, 'cat /var/mobile/Library/CarPWA/dev-token');
});

test('doctor: every check passes, read-only', async (t) => {
  const { env, sshCalls } = await setup(t);
  const r = await runCLI(['doctor'], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const line of [
    /✓ ssh reachable\s+`ssh phone` works/,
    /✓ jbroot found\s+\/var\/jb \(rootless\)/,
    /✓ CarPWA installed\s+com\.andi\.carpwa 1\.0\.0/,
    /✓ carpwad running\s+carpwad 1\.0\.0-fake on 127\.0\.0\.1:47800/,
    /✓ token readable\s+\/var\/jb\/var\/mobile\/Library\/CarPWA\/dev-token \(accepted\)/,
    /✓ iOS version\s+iOS 16\.5/,
  ]) assert.match(r.stdout, line);
  // Nothing but reads on the phone.
  for (const call of sshCalls()) {
    assert.ok(!call.command || /^(true|test -d|cat |PATH=.* dpkg -s|sw_vers)/.test(call.command), call.command);
  }
});

test('doctor: failures come with fixes; no SSH skips the rest', async (t) => {
  const { env } = await setup(t);
  let r = await runCLI(['doctor'], { env: { ...env, FAKE_NO_CARPWA: '1', FAKE_TOKEN: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ CarPWA installed\s+com\.andi\.carpwa is not installed/);
  assert.match(r.stdout, /fix: install CarPWA/);
  assert.match(r.stdout, /✗ token readable\s+cannot read/);
  assert.match(r.stdout, /2 checks failed/);

  r = await runCLI(['doctor'], { env: { ...env, FAKE_SSH_FAIL: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ ssh reachable/);
  assert.match(r.stdout, /– jbroot found\s+skipped \(no SSH\)/);
  assert.match(r.stdout, /– iOS version\s+skipped/);

  r = await runCLI(['doctor'], { env: { ...env, FAKE_JBROOT: '' } });
  assert.match(r.stdout, /✗ jbroot found\s+no \/var\/jb/);
});

test('logs streams dev.log events with the app id', async (t) => {
  const { env } = await setup(t);
  const cli = startCLI(['logs', '--app', 'com.test.push'], { env });
  await cli.waitFor(/com\.test\.push .*hello from the phone \{"n":1\}/);
  assert.equal(await cli.stop(), 0);
});

test('dev pushes, forwards the app port, prints the desktop URL and syncs every save', async (t) => {
  const { daemon, dir, env } = await setup(t);
  const appServer = http.createServer((req, res) => res.end(`app page ${req.url}`));
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  t.after(() => appServer.close());

  const cli = startCLI(['dev', dir], { env: { ...env, FAKE_APP_PORT: String(appServer.address().port) } });
  await cli.waitFor(/Pushed Pushy/);
  const out = await cli.waitFor(/desktop\s+http:\/\/localhost:\d+\/index\.html\?carpwa_devtoken=test-token/);
  const url = /desktop\s+(http:\/\/localhost:\d+\/\S+)/.exec(out)[1];
  const page = await new Promise((resolve, reject) => {
    http.get(url.replace('localhost', '127.0.0.1'), (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject);
  });
  assert.match(page, /^app page \/index\.html\?carpwa_devtoken=test-token/);

  await cli.waitFor(/hello from the phone/);
  await cli.waitFor(/Watching/);
  await new Promise((r) => setTimeout(r, 600));   // let FSEvents settle
  const reloadsBefore = daemon.reloads;
  writeFileSync(join(dir, 'app.js'), '// edited\n');
  await cli.waitFor(/sync ↑ app\.js/);
  assert.equal(daemon.apps.get('com.test.push').files.get('app.js').toString(), '// edited\n');
  assert.ok(daemon.reloads > reloadsBefore);

  writeFileSync(join(dir, 'carpwa.json'), '{"id": "com.test.push"}');
  await cli.waitFor(/not syncing until carpwa\.json is fixed/);
  assert.equal(await cli.stop(), 0);
});

test('package builds a rootless .deb that dpkg-deb reads', async (t) => {
  const { dir } = await setup(t);
  const out = tempDir(t);
  const r = await runCLI(['package', dir, '--out', out, '--maintainer', 'Dev <dev@example.com>', '--depiction-url', 'https://example.com/pushy']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /com\.test\.push_1\.0\.0_iphoneos-arm64\.deb/);
  assert.match(r.stdout, /installs to \/var\/jb\/Library\/CarPWA\/Apps\/com\.test\.push\//);
  assert.match(r.stdout, /dpkg-deb -I and -c read it: 6 files|dpkg-deb not found/);
});

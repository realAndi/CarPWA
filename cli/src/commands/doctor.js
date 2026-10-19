import { parseArgs } from '../args.js';
import {
  sshHost, runSSH, sshError, openTunnel, Device, carpwaDataPath, CONTROL_PORT, CARPWA_PACKAGE,
} from '../device.js';
import { c, verbose } from '../log.js';

export const help = `Usage: carpwa doctor [--host <ssh host>]

Checks, in order, everything device commands need, and prints a fix for each
failure: SSH, the jailbreak root, the CarPWA package, carpwad, the dev token,
and the iOS version. Read-only: it changes nothing on the phone.`;

const ROW = 18;

export async function run(argv) {
  parseArgs(argv, {});
  const host = sshHost();
  console.log(`${c.bold('carpwa doctor')} ${c.dim(`· ssh host "${host}"`)}`);
  console.log('');

  let failed = 0;
  const report = (okay, name, detail, hint) => {
    console.log(`${okay ? c.green('✓') : c.red('✗')} ${name.padEnd(ROW)} ${detail}`);
    if (!okay) {
      failed++;
      if (hint) console.log(`  ${' '.repeat(ROW)} ${c.yellow('fix:')} ${hint}`);
    }
  };
  const skip = (name, why) => console.log(`${c.dim('–')} ${name.padEnd(ROW)} ${c.dim(`skipped (${why})`)}`);

  // 1. ssh
  const ping = await runSSH('true', { host, timeout: 20000 });
  if (ping.code !== 0) {
    report(false, 'ssh reachable', sshError(host, 'true', ping).message.replace(/ \(set --host.*$/, ''),
      `make \`ssh ${host}\` work first: right address (--host or CARPWA_HOST), OpenSSH installed on the phone, same network or \`iproxy 2222 22\` for USB, a key in ~/.ssh`);
    for (const name of ['jbroot found', 'CarPWA installed', 'carpwad running', 'token readable', 'iOS version']) skip(name, 'no SSH');
    return 1;
  }
  report(true, 'ssh reachable', `\`ssh ${host}\` works`);

  // 2. jbroot
  const jb = await runSSH('test -d /var/jb && echo /var/jb || echo', { host });
  const jbroot = jb.stdout.trim() === '/var/jb' ? '/var/jb' : '';
  if (jb.code === 0 && jbroot) report(true, 'jbroot found', '/var/jb (rootless)');
  else report(false, 'jbroot found', 'no /var/jb', 'CarPWA is built for rootless jailbreaks (Dopamine, palera1n rootless); on a rootful jailbreak paths start at /');

  // 3. package
  const pkgCmd = `PATH="$PATH:${jbroot || ''}/usr/bin:${jbroot || ''}/bin" dpkg -s ${CARPWA_PACKAGE}`;
  const pkg = await runSSH(pkgCmd, { host });
  const status = /^Status:\s*(.+)$/m.exec(pkg.stdout);
  const version = /^Version:\s*(.+)$/m.exec(pkg.stdout);
  if (pkg.code === 0 && status && /install ok installed/.test(status[1])) {
    report(true, 'CarPWA installed', `${CARPWA_PACKAGE} ${version ? version[1].trim() : ''}`.trim());
  } else {
    report(false, 'CarPWA installed', status ? `dpkg status: ${status[1].trim()}` : `${CARPWA_PACKAGE} is not installed`,
      `install CarPWA from its repo in Sileo or Zebra, or \`apt install ${CARPWA_PACKAGE}\``);
  }

  // 4. carpwad, through a tunnel to the control port
  let device = null;
  let tunnel = null;
  try {
    tunnel = await openTunnel(CONTROL_PORT, { host });
    device = new Device({ host, jbroot, token: '', tunnel });
    const health = await device.request('GET', '/_carpwa/health', undefined, { timeout: 10000 });
    if (health.status === 200 && health.json && health.json.ok) {
      report(true, 'carpwad running', `carpwad ${health.json.version || ''} on 127.0.0.1:${CONTROL_PORT}`.replace('  ', ' '));
    } else {
      report(false, 'carpwad running', `/_carpwa/health answered HTTP ${health.status}`, 'reinstall CarPWA, or reboot userspace (`launchctl reboot userspace`) so its launch daemon restarts');
    }
  } catch (e) {
    verbose(e.message);
    report(false, 'carpwad running', `nothing answers on 127.0.0.1:${CONTROL_PORT}`,
      'carpwad starts with CarPWA: check `launchctl list | grep -i carpwa` on the phone, reinstall CarPWA, or reboot userspace');
  }

  // 5. dev token: readable, and accepted when carpwad is up
  const tokenPath = carpwaDataPath(jbroot, 'dev-token');
  const tok = await runSSH(`cat ${tokenPath}`, { host });
  const token = tok.stdout.trim();
  if (tok.code !== 0 || !token) {
    report(false, 'token readable', `cannot read ${tokenPath}`, 'carpwad writes it on first start; if it exists, log in as mobile or root (it is mode 0600, owner mobile)');
  } else if (device) {
    device.token = token;
    const probe = await device.request('GET', '/_carpwa/apps', undefined, { timeout: 10000 }).catch(() => null);
    if (probe && probe.status === 401) report(false, 'token readable', `${tokenPath} (rejected by carpwad)`, 'the daemon and the file disagree; restart carpwad so it re-reads its token');
    else report(true, 'token readable', `${tokenPath}${probe && probe.status === 200 ? ' (accepted)' : ''}`);
  } else {
    report(true, 'token readable', tokenPath);
  }
  if (tunnel) tunnel.close();

  // 6. iOS version
  const ios = await runSSH(
    'sw_vers -productVersion 2>/dev/null || plutil -key ProductVersion /System/Library/CoreServices/SystemVersion.plist 2>/dev/null || plutil -extract ProductVersion raw -o - /System/Library/CoreServices/SystemVersion.plist',
    { host },
  );
  const iosVersion = ios.stdout.trim().split(/\s+/)[0];
  if (ios.code === 0 && /^\d+(\.\d+)*$/.test(iosVersion)) report(true, 'iOS version', `iOS ${iosVersion}`);
  else report(false, 'iOS version', 'could not read it', 'install `sw_vers` (Procursus "sw-vers") or `plutil`; this check is informational');

  console.log('');
  console.log(failed ? c.red(`${failed} check${failed === 1 ? '' : 's'} failed`) : c.green('Everything looks good.'));
  return failed ? 1 : 0;
}

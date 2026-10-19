import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from '../args.js';
import { loadApp, compareVersions } from '../manifest.js';
import { listAppFiles, formatBytes } from '../files.js';
import { buildDeb } from '../deb.js';
import { CARPWA_PACKAGE } from '../device.js';
import { c, CliError, ok, warn } from '../log.js';

const ARCH = 'iphoneos-arm64';
const DEB_NAME_RE = /^[a-z0-9][a-z0-9+.-]+$/;
const DEB_VERSION_RE = /^[0-9][A-Za-z0-9.+~-]*$/;

export const help = `Usage: carpwa package [dir] [--out dist] [--maintainer "Name <email>"] [--depiction-url <url>]

Builds an installable rootless .deb, in pure Node: the app goes to
/var/jb/Library/CarPWA/Apps/<id>/, the package depends on ${CARPWA_PACKAGE},
and postinst/postrm run \`carpwactl rescan\`. When dpkg-deb is on PATH the
result is read back with \`dpkg-deb -I\` and \`-c\`.

Options:
  --out <dir>             output folder (default dist)
  --maintainer <who>      "Name <email>" (default: git config user.name / user.email)
  --depiction-url <url>   Depiction field for Sileo/Zebra`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, {
    out: { type: 'string', alias: 'o', default: 'dist' },
    maintainer: { type: 'string' },
    depictionUrl: { type: 'string' },
  });
  const { dir, manifest, raw } = loadApp(positionals[0] || '.');

  const pkg = manifest.id.toLowerCase();
  if (!DEB_NAME_RE.test(pkg)) {
    throw new CliError(`"${pkg}" is not a valid Debian package name; the app id must start with a letter or digit`);
  }
  const version = manifest.version;
  if (!DEB_VERSION_RE.test(version)) {
    throw new CliError(`version "${version}" is not a valid Debian version (it must start with a digit); fix "version" in carpwa.json`);
  }
  if (opts.depictionUrl && !/^https?:\/\//.test(opts.depictionUrl)) throw new CliError('--depiction-url must be an http(s) URL');

  const appFiles = listAppFiles(dir);
  const root = `./var/jb/Library/CarPWA/Apps/${manifest.id}/`;
  const files = appFiles.map((f) => ({ path: root + f.rel, data: readFileSync(f.abs) }));
  const installedKB = Math.max(1, Math.ceil(appFiles.reduce((n, f) => n + f.size, 0) / 1024));

  const minCarpwa = manifest.min_carpwa && compareVersions(manifest.min_carpwa, '1.0') > 0 ? manifest.min_carpwa : '1.0';
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description : manifest.name;
  const maintainer = opts.maintainer || gitIdentity();
  const control = [
    `Package: ${pkg}`,
    `Name: ${oneLine(manifest.name)}`,
    `Version: ${version}`,
    `Architecture: ${ARCH}`,
    `Description: ${oneLine(description)}`,
    maintainer && `Maintainer: ${oneLine(maintainer)}`,
    maintainer && `Author: ${oneLine(maintainer)}`,
    'Section: CarPWA',
    `Depends: ${CARPWA_PACKAGE} (>= ${minCarpwa})`,
    opts.depictionUrl && `Depiction: ${oneLine(opts.depictionUrl)}`,
    `Installed-Size: ${installedKB}`,
  ].filter(Boolean).join('\n') + '\n';

  const deb = buildDeb({ control, scripts: { postinst: RESCAN, postrm: RESCAN }, files });
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${manifest.id}_${version}_${ARCH}.deb`);
  writeFileSync(out, deb);

  ok(`Built ${c.bold(relative(process.cwd(), out) || out)} ${c.dim(`(${formatBytes(deb.length)}, ${appFiles.length} files)`)}`);
  console.log(`  ${c.dim('installs to')} ${root.slice(1)}`);
  if (!maintainer) warn('no Maintainer field: pass --maintainer "Name <email>" or set git user.name/user.email');

  const check = verifyWithDpkg(out, root, appFiles.length);
  if (check === null) console.log(`  ${c.dim('dpkg-deb not found on PATH; skipped reading the package back')}`);
  else ok(`dpkg-deb -I and -c read it: ${check} files under ${root.slice(1)}`);
  return 0;
}

// Runs on the phone after install and removal so carpwad picks the change up.
const RESCAN = `#!/var/jb/usr/bin/sh
/var/jb/usr/bin/carpwactl rescan || true
`;

/**
 * Reads the .deb back with dpkg-deb. Returns the number of app files it
 * lists, null when dpkg-deb is missing, and throws when the package is off.
 */
export function verifyWithDpkg(file, root, expectedFiles) {
  const run = (args) => spawnSync('dpkg-deb', args, { encoding: 'utf8' });
  const info = run(['-I', file]);
  if (info.error && info.error.code === 'ENOENT') return null;
  if (info.status !== 0) throw new CliError(`dpkg-deb -I rejected the package: ${(info.stderr || '').trim().split('\n').pop()}`);
  if (!/^ Package: /m.test(info.stdout) || !/ postinst/.test(info.stdout)) throw new CliError('dpkg-deb -I shows no control file or postinst');

  const list = run(['-c', file]);
  if (list.status !== 0) throw new CliError(`dpkg-deb -c rejected the package: ${(list.stderr || '').trim().split('\n').pop()}`);
  const entries = list.stdout.trim().split('\n').map((line) => {
    const m = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    return m && { mode: m[1], owner: m[2], path: m[3] };
  }).filter(Boolean);
  const appEntries = entries.filter((e) => e.path.startsWith(root) && e.path !== root && !e.mode.startsWith('d'));
  const stray = entries.filter((e) => !e.path.startsWith(root) && !root.startsWith(e.path));
  if (stray.length) throw new CliError(`unexpected path in the package: ${stray[0].path}`);
  const badOwner = entries.find((e) => e.owner !== 'root/wheel' && e.owner !== '0/0');
  if (badOwner) throw new CliError(`${badOwner.path} is owned by ${badOwner.owner}, not root/wheel`);
  if (appEntries.length !== expectedFiles) throw new CliError(`dpkg-deb lists ${appEntries.length} app files, expected ${expectedFiles}`);
  return appEntries.length;
}

function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

function gitIdentity() {
  const get = (key) => {
    try {
      const r = spawnSync('git', ['config', '--get', key], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : '';
    } catch {
      return '';
    }
  };
  const name = get('user.name');
  const email = get('user.email');
  if (!name && !email) return '';
  return email ? `${name || email} <${email}>` : name;
}

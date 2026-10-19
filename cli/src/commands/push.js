import { parseArgs } from '../args.js';
import { loadApp } from '../manifest.js';
import { openDevice } from '../device.js';
import { syncApp, reloadApp } from '../sync.js';
import { formatBytes } from '../files.js';
import { c, ok } from '../log.js';

export const help = `Usage: carpwa push [dir] [--reload] [--host <ssh host>]

Validates the app and copies it to the phone with the sync protocol: only
files whose SHA-1 changed are uploaded, and files you deleted locally are
removed on the phone. Dot-files, node_modules and .carpwaignore matches are
never sent.

Options:
  --reload        also reload open pages of the app afterwards
  --host <host>   ssh host of the phone (default $CARPWA_HOST, else "iphone")`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, { reload: { type: 'boolean' } });
  const { dir, manifest } = loadApp(positionals[0] || '.');
  const device = await openDevice();
  try {
    const r = await syncApp(device, dir, manifest);
    const clients = opts.reload ? await reloadApp(device, manifest.id) : null;
    printPushResult(device, manifest, r, clients);
  } finally {
    device.close();
  }
  return 0;
}

export function printPushResult(device, manifest, r, clients) {
  const changed = r.uploaded.length
    ? `${r.uploaded.length} of ${r.total} file${r.total === 1 ? '' : 's'} uploaded (${formatBytes(r.bytes)})`
    : `all ${r.total} files already up to date`;
  const removed = r.removed.length ? `, ${r.removed.length} removed` : '';
  ok(`Pushed ${c.bold(manifest.name)} ${manifest.version} to ${device.host}: ${changed}${removed}`);
  printEntry(r.entry);
  if (clients !== null && clients !== undefined) console.log(`  ${c.dim('reloaded'.padEnd(8))} ${clients} page${clients === 1 ? '' : 's'}`);
}

export function printEntry(entry) {
  for (const key of ['id', 'name', 'version', 'port', 'url', 'origin', 'path']) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') console.log(`  ${c.dim(key.padEnd(8))} ${entry[key]}`);
  }
}

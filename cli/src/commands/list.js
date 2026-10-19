import { parseArgs } from '../args.js';
import { openDevice } from '../device.js';
import { c } from '../log.js';

export const help = `Usage: carpwa list [--json] [--host <ssh host>]

Lists the CarPWA apps on the phone: packaged ones (origin "system") and the
ones you pushed (origin "user").

Options:
  --json          print the raw GET /_carpwa/apps reply`;

export async function run(argv) {
  const { opts } = parseArgs(argv, { json: { type: 'boolean' } });
  const device = await openDevice();
  let apps;
  try {
    apps = await device.call('GET', '/_carpwa/apps');
  } finally {
    device.close();
  }
  apps = Array.isArray(apps) ? apps : [];
  if (opts.json) {
    console.log(JSON.stringify(apps, null, 2));
    return 0;
  }
  if (!apps.length) {
    console.log('No CarPWA apps on the phone yet. Push one with `carpwa push`.');
    return 0;
  }
  console.log(table(['ID', 'NAME', 'VERSION', 'PORT', 'ORIGIN'], apps.map((a) => [a.id, a.name, a.version, a.port, a.origin])));
  return 0;
}

export function table(head, rows) {
  const cells = rows.map((r) => r.map((v) => (v === undefined || v === null ? '' : String(v))));
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));
  const line = (cols) => cols.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [c.dim(line(head)), ...cells.map(line)].join('\n');
}

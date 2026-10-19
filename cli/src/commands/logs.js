import { parseArgs } from '../args.js';
import { ID_RE } from '../manifest.js';
import { openDevice } from '../device.js';
import { c, CliError } from '../log.js';
import { tailLogs } from './dev.js';

export const help = `Usage: carpwa logs [--app <id>] [--host <ssh host>]

Streams console output from app pages on the phone until Ctrl-C. Every line
is prefixed with the app id.

Options:
  --app <id>      only this app (default: every app)`;

export async function run(argv) {
  const { opts } = parseArgs(argv, { app: { type: 'string' } });
  if (opts.app && !ID_RE.test(opts.app)) throw new CliError(`"${opts.app}" is not a valid app id`);

  const device = await openDevice();
  const ws = await tailLogs(device, opts.app || null);
  if (!ws) { device.close(); return 1; }
  console.log(c.dim(`Following ${opts.app || 'all apps'} on ${device.host}. Ctrl-C to stop.`));

  return new Promise((resolveDone) => {
    let stopped = false;
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      ws.close();
      device.close();
      resolveDone(code);
    };
    ws.on('close', () => { if (!stopped) console.error(c.yellow('connection to the phone closed')); stop(1); });
    device.onClose = () => stop(1);
    process.once('SIGINT', () => stop(0));
    process.once('SIGTERM', () => stop(0));
  });
}

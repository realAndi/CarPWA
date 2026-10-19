import { parseArgs } from '../args.js';
import { ID_RE } from '../manifest.js';
import { openDevice } from '../device.js';
import { reloadApp } from '../sync.js';
import { CliError, ok } from '../log.js';

export const help = `Usage: carpwa reload <id> [--host <ssh host>]

Sends dev.reload to every open page of the app on the phone and prints how
many pages got it.`;

export async function run(argv) {
  const { positionals } = parseArgs(argv, {});
  const id = positionals[0];
  if (!id) throw new CliError('carpwa reload needs an app id, e.g. `carpwa reload com.you.app`');
  if (!ID_RE.test(id)) throw new CliError(`"${id}" is not a valid app id`);
  const device = await openDevice();
  let clients;
  try {
    clients = await reloadApp(device, id);
  } catch (e) {
    if (e.status === 404) throw new CliError(`${id} is not on the phone (\`carpwa list\` shows what is)`);
    throw e;
  } finally {
    device.close();
  }
  ok(`Reloaded ${id}: ${clients} page${clients === 1 ? '' : 's'}`);
  return 0;
}

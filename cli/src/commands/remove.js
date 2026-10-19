import { parseArgs } from '../args.js';
import { ID_RE } from '../manifest.js';
import { openDevice } from '../device.js';
import { appPath } from '../sync.js';
import { CliError, ok } from '../log.js';

export const help = `Usage: carpwa remove <id> [--host <ssh host>]

Deletes an app you pushed (origin "user") from the phone. Apps installed from
a package (origin "system") are refused; remove those with your package
manager. The app's storage on the phone is kept.`;

export async function run(argv) {
  const { positionals } = parseArgs(argv, {});
  const id = positionals[0];
  if (!id) throw new CliError('carpwa remove needs an app id, e.g. `carpwa remove com.you.app`');
  if (!ID_RE.test(id)) throw new CliError(`"${id}" is not a valid app id`);

  const device = await openDevice();
  try {
    const entry = device.apps.find((a) => a.id === id);
    if (!entry) throw new CliError(`${id} is not on the phone (\`carpwa list\` shows what is)`);
    if (entry.origin === 'system') {
      throw new CliError(`${id} was installed from a package (origin "system"); remove it with Sileo, Zebra or apt instead`);
    }
    await device.call('DELETE', appPath(id));
  } finally {
    device.close();
  }
  ok(`Removed ${id} from ${device.host}`);
  return 0;
}

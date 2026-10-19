import { parseArgs } from '../args.js';
import { CliError } from '../log.js';

export const help = `Usage: carpwa open <id>

Opening an app remotely is not supported over SSH in this version. Apps you
push or install show up on the CarPlay home screen; tap the icon there.`;

export async function run(argv) {
  const { positionals } = parseArgs(argv, {});
  const id = positionals[0];
  if (!id) throw new CliError('carpwa open needs an app id');
  console.log(`carpwa open is not supported over SSH in v1. ${id} is on the CarPlay home screen: tap its icon there.`);
  return 0;
}

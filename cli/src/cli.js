// Command dispatch. Each command module exports `help` and `run(argv)`.
// Global flags (--host, --verbose) are accepted anywhere on the command line.

import { c, CliError, globals } from './log.js';
import { cliVersion, sdkVersion } from './sdk.js';

const COMMANDS = {
  create: { load: () => import('./commands/create.js'), summary: 'scaffold a new app (templates: blank, media, dashboard)' },
  validate: { load: () => import('./commands/validate.js'), summary: 'check carpwa.json, the start page and the icon' },
  sim: { load: () => import('./commands/sim.js'), summary: 'run the app in the desktop CarPlay simulator' },
  doctor: { load: () => import('./commands/doctor.js'), summary: 'check SSH, CarPWA and carpwad on the phone (read-only)' },
  push: { load: () => import('./commands/push.js'), summary: 'copy the app to the phone (only changed files)' },
  dev: { load: () => import('./commands/dev.js'), summary: 'push on every save, reload, and stream the page console' },
  list: { load: () => import('./commands/list.js'), summary: 'list the CarPWA apps on the phone' },
  remove: { load: () => import('./commands/remove.js'), summary: 'delete an app you pushed from the phone' },
  reload: { load: () => import('./commands/reload.js'), summary: 'reload the open pages of an app on the phone' },
  logs: { load: () => import('./commands/logs.js'), summary: 'stream console output from apps on the phone' },
  open: { load: () => import('./commands/open.js'), summary: 'not available over SSH yet; explains where the app is' },
  package: { load: () => import('./commands/package.js'), summary: 'build an installable .deb (rootless)' },
};

const ALIASES = {
  new: 'create', init: 'create', check: 'validate', lint: 'validate', simulate: 'sim', simulator: 'sim',
  ls: 'list', rm: 'remove', deb: 'package', pack: 'package', log: 'logs',
};

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const rows = Object.entries(COMMANDS).map(([name, cmd]) => `  ${c.bold(name.padEnd(width))}  ${cmd.summary}`);
  return `${c.bold('carpwa')} ${cliVersion()} ${c.dim(`(SDK ${safeSdkVersion()})`)} — build web apps for the CarPlay screen

Usage: carpwa <command> [options]

Commands:
${rows.join('\n')}

Global options:
  --host <host>   ssh host of the phone (default $CARPWA_HOST, else "iphone")
  --verbose       print ssh commands, HTTP requests and stack traces
  --help, -h      help for a command
  --version       print the CLI version

Quick start:
  carpwa create my-app --template media
  cd my-app && carpwa sim --open
  carpwa doctor && carpwa dev`;
}

function safeSdkVersion() {
  try { return sdkVersion(); } catch { return 'missing'; }
}

/** Removes --host/--verbose from argv and records them in `globals`. */
export function takeGlobals(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i)); break; }
    if (a === '--verbose') globals.verbose = true;
    else if (a === '--host') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) throw new CliError('--host needs a value, e.g. --host iphone');
      globals.host = argv[++i];
    } else if (a.startsWith('--host=')) globals.host = a.slice(7);
    else rest.push(a);
  }
  return rest;
}

export async function main(argv) {
  const [first, ...rest] = takeGlobals(argv);
  if (!first || first === '-h' || first === '--help' || first === 'help') {
    if (first === 'help' && rest[0]) return main([rest[0], '--help']);
    console.log(usage());
    return 0;
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    console.log(cliVersion());
    return 0;
  }
  const name = ALIASES[first] || first;
  const entry = COMMANDS[name];
  if (!entry) throw new CliError(`unknown command "${first}"; run \`carpwa --help\` for the list`);
  const cmd = await entry.load();
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(cmd.help);
    return 0;
  }
  return cmd.run(rest);
}

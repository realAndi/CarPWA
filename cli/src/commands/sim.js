import { spawn } from 'node:child_process';
import { parseArgs } from '../args.js';
import { loadApp } from '../manifest.js';
import { SimServer, PRESETS, INPUTS } from '../simserver.js';
import { sdkDir } from '../sdk.js';
import { c, CliError, printPageLog, time, warn, error as printError } from '../log.js';

export const help = `Usage: carpwa sim [dir] [options]

Runs the app in a desktop CarPlay simulator: a head unit with a mock car,
media player, navigation, location, knob input, storage and channels. The
folder is watched; every change sends dev.reload to the app's pages.

Options:
  --port <n>         port to listen on (default 5173, the next free one is used if taken)
  --strict-port      fail instead of trying the next port
  --preset <name>    ${Object.entries(PRESETS).map(([k, p]) => `${k} (${p.width}×${p.height})`).join(', ')}
                     the app's size in CSS px (default standard)
  --input <model>    ${INPUTS.join(' | ')} (default touch)
  --open             open the simulator in your browser
  --reset-storage    start with empty storage for this app`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, {
    port: { type: 'number', alias: 'p', default: 5173 },
    strictPort: { type: 'boolean' },
    preset: { type: 'string', default: 'standard' },
    input: { type: 'string', default: 'touch' },
    open: { type: 'boolean', alias: 'o' },
    resetStorage: { type: 'boolean' },
  });
  if (!PRESETS[opts.preset]) throw new CliError(`--preset must be one of ${Object.keys(PRESETS).join(', ')}`);
  if (!INPUTS.includes(opts.input)) throw new CliError(`--input must be one of ${INPUTS.join(', ')}`);
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new CliError('--port must be 0–65535');

  sdkDir();   // fail now, not on the first page load, if the SDK is missing
  const { dir, manifest } = loadApp(positionals[0] || '.');

  const sim = new SimServer({
    dir,
    port: opts.port,
    preset: opts.preset,
    input: opts.input,
    resetStorage: opts.resetStorage,
    onLog: (entry) => printPageLog(entry),
    onEvent: (evt) => {
      if (evt.type === 'manifest') {
        const v = evt.validation;
        if (v.errors.length) {
          for (const e of v.errors) printError(`carpwa.json: ${e}`);
        } else {
          console.log(`${c.gray(time())} ${c.green('manifest')} ${v.manifest.name} ${c.dim(v.manifest.id)} reloaded`);
          for (const w of v.warnings) warn(`carpwa.json: ${w}`);
        }
      } else if (evt.type === 'reload') {
        const files = `${evt.files.slice(0, 4).join(', ')}${evt.files.length > 4 ? ` +${evt.files.length - 4}` : ''}`;
        console.log(`${c.gray(time())} ${c.cyan('reload')} ${files} ${c.dim(`→ dev.reload to ${evt.pages} page${evt.pages === 1 ? '' : 's'}`)}`);
      }
    },
  });

  let port;
  try {
    port = await sim.listen({ strictPort: opts.strictPort });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new CliError(`port ${opts.port} is in use; pick another with --port`);
    throw e;
  }
  sim.startWatching();

  const preset = PRESETS[opts.preset];
  console.log('');
  console.log(`  ${c.bold('CarPWA simulator')}  ${c.dim(manifest.name + ' · ' + manifest.id)}`);
  console.log('');
  console.log(`  ${c.green('➜')}  Simulator  ${c.cyan(sim.url)}`);
  console.log(`  ${c.dim('➜')}  App only   ${c.dim(`http://127.0.0.1:${port}/${manifest.start_url}`)}`);
  console.log(`  ${c.dim('➜')}  Screen     ${c.dim(`${opts.preset} ${preset.width}×${preset.height}, ${opts.input} input`)}`);
  console.log(`  ${c.dim('➜')}  Storage    ${c.dim(sim.storageFile)}`);
  if (port !== opts.port) console.log(`  ${c.yellow('!')}  port ${opts.port} was busy, using ${port}`);
  console.log('');
  console.log(c.dim('  Watching for changes. Page console output appears below. Ctrl-C to stop.'));
  console.log('');

  if (opts.open) openBrowser(sim.url);

  await new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      console.log('');
      sim.close().then(resolve);
      setTimeout(resolve, 1500).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => warn(`could not open a browser; visit ${url}`));
    child.unref();
  } catch {
    warn(`could not open a browser; visit ${url}`);
  }
}

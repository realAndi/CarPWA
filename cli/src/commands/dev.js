import { parseArgs } from '../args.js';
import { loadApp, validateApp, printReport } from '../manifest.js';
import { openDevice, freePort } from '../device.js';
import { syncApp, reloadApp } from '../sync.js';
import { watchFolder } from '../watch.js';
import { formatBytes } from '../files.js';
import { c, CliError, printPageLog, time, warn, error as printError } from '../log.js';
import { printPushResult } from './push.js';

export const help = `Usage: carpwa dev [dir] [--no-logs] [--host <ssh host>]

Pushes the app, then watches the folder: every save (debounced 150 ms) is
synced incrementally and open pages reload. The page console streams here
(dev.tailLogs), and the app's port is forwarded so you can also open it in a
desktop browser with the real server bridge. The SSH tunnel reconnects if it
drops. Ctrl-C to stop.

Options:
  --no-logs       do not stream the page console`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, { logs: { type: 'boolean', default: true } });
  let { dir, manifest } = loadApp(positionals[0] || '.');

  let device = await openDevice();
  let socket = null;
  let stopped = false;

  const connectExtras = async (entry) => {
    await forwardApp(device, entry, manifest);
    if (opts.logs) socket = await tailLogs(device, manifest.id);
  };

  const first = await syncApp(device, dir, manifest);
  printPushResult(device, manifest, first, await reloadApp(device, manifest.id));
  await connectExtras(first.entry);

  console.log('');
  console.log(c.dim(`  Watching ${dir}; saves sync to the phone. Ctrl-C to stop.`));
  console.log('');

  // One sync at a time; changes during a sync trigger exactly one more.
  let running = false;
  let again = false;
  let pendingFiles = new Set();
  const runSync = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const files = [...pendingFiles];
        pendingFiles = new Set();
        if (files.includes('carpwa.json')) {
          const v = validateApp(dir);
          if (v.errors.length) {
            printReport(v);
            printError('not syncing until carpwa.json is fixed');
            continue;
          }
          if (v.manifest.id !== manifest.id) {
            throw new CliError(`"id" changed from ${manifest.id} to ${v.manifest.id}; restart \`carpwa dev\``);
          }
          for (const w of v.warnings) warn(`carpwa.json: ${w}`);
          manifest = v.manifest;
        }
        const r = await syncApp(device, dir, manifest);
        if (!r.uploaded.length && !r.removed.length) continue;
        const clients = await reloadApp(device, manifest.id);
        const what = [...r.uploaded.map((f) => `↑ ${f}`), ...r.removed.map((f) => `✕ ${f}`)];
        const shown = what.slice(0, 4).join('  ') + (what.length > 4 ? `  +${what.length - 4}` : '');
        console.log(`${c.gray(time())} ${c.cyan('sync')} ${shown} ${c.dim(`(${formatBytes(r.bytes)}, reloaded ${clients})`)}`);
      } while (again && !stopped);
    } catch (e) {
      if (/"id" changed/.test(e.message)) { printError(e.message); stop(1); return; }
      if (!stopped) printError(`sync failed: ${e.message}`);
    } finally {
      running = false;
    }
  };

  const stopWatching = watchFolder(dir, (files) => {
    for (const f of files) pendingFiles.add(f);
    runSync();
  }, { debounce: 150 });

  // Phone asleep, Wi-Fi change: reopen the tunnel, resync, re-tail.
  const reconnect = async () => {
    if (stopped) return;
    socket = null;
    warn(`lost the SSH tunnel to ${device.host}; reconnecting…`);
    for (let delay = 2000; !stopped; delay = Math.min(delay * 2, 30000)) {
      await new Promise((r) => setTimeout(r, delay));
      if (stopped) return;
      try {
        device = await openDevice({ host: device.host });
        device.onClose = reconnect;
        console.log(`${c.gray(time())} ${c.green('reconnected')} to ${device.host}`);
        const r = await syncApp(device, dir, manifest);
        await reloadApp(device, manifest.id);
        await connectExtras(r.entry);
        return;
      } catch (e) {
        warn(`still offline (${e.message})`);
      }
    }
  };
  device.onClose = reconnect;

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  function stop(code = 0) {
    if (stopped) return;
    stopped = true;
    stopWatching();
    if (socket) socket.close();
    device.onClose = null;
    device.close();
    resolveDone(code);
  }
  process.once('SIGINT', () => { console.log(''); stop(0); });
  process.once('SIGTERM', () => stop(0));
  return done;
}

/**
 * Forwards the app's port on the phone to the same port here when it is free:
 * carpwad only accepts WebSocket Origins of http://127.0.0.1:<app port> and
 * http://localhost:<app port>, so another local port would lose the server bridge.
 */
async function forwardApp(device, entry, manifest) {
  const appPort = Number(entry && entry.port);
  if (!appPort) return null;
  try {
    const local = await freePort(appPort);
    const t = await device.forward(appPort, local);
    const start = manifest.start_url;
    const url = `http://localhost:${t.port}/${start}${start.includes('?') ? '&' : '?'}carpwa_devtoken=${encodeURIComponent(device.token)}`;
    console.log(`  ${c.dim('desktop'.padEnd(8))} ${c.cyan(url)}`);
    if (t.port !== appPort) {
      warn(`local port ${appPort} is busy, forwarded to ${t.port}; carpwad checks the Origin port, so that tab gets no server bridge`);
    }
    return t;
  } catch (e) {
    warn(`could not forward the app port: ${e.message}`);
    return null;
  }
}

/** Opens the control WebSocket and streams `dev.log` events (one app, or all). */
export async function tailLogs(device, appId) {
  let ws;
  try {
    ws = await device.socket();
  } catch (e) {
    warn(`log streaming unavailable: ${e.message}`);
    return null;
  }
  ws.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'event' && msg.module === 'dev' && msg.event === 'log' && msg.data) {
      printPageLog(msg.data);
    } else if (msg.type === 'error' && msg.id === 1) {
      warn(`log streaming refused: ${(msg.error && msg.error.message) || 'unknown error'}`);
    }
  });
  ws.sendJSON({ id: 1, type: 'call', module: 'dev', method: 'tailLogs', params: appId ? { app: appId } : {} });
  return ws;
}

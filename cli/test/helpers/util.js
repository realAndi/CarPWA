import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(CLI_ROOT, 'bin', 'carpwa.js');

export function tempDir(t, prefix = 'carpwa-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the CLI; resolves { code, stdout, stderr }. */
export function runCLI(args, { env = {}, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Starts the CLI and returns helpers to wait for output and stop it. */
export function startCLI(args, { env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const waiters = [];
  const onData = (d) => {
    output += d;
    for (const w of [...waiters]) if (w.re.test(output)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(output); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((r) => child.on('close', (code) => r(code)));
  return {
    child,
    get output() { return output; },
    waitFor(re, timeout = 10000) {
      if (re.test(output)) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timed out waiting for ${re}; output so far:\n${output}`)), timeout).unref();
      });
    },
    stop(signal = 'SIGINT') { child.kill(signal); return exited; },
    exited,
  };
}

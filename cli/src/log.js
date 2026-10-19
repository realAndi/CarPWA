// Terminal output helpers. Colors only when stdout is a TTY and NO_COLOR is unset.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function wrap(open, close) {
  return (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Global flags, set once by cli.js: --host and --verbose. */
export const globals = { host: null, verbose: false };

/** Diagnostic output for --verbose (ssh commands, HTTP requests). */
export function verbose(msg) {
  if (globals.verbose) process.stderr.write(c.gray(`· ${msg}`) + '\n');
}

export function info(msg) { console.log(msg); }
export function step(msg) { console.log(`${c.cyan('›')} ${msg}`); }
export function ok(msg) { console.log(`${c.green('✓')} ${msg}`); }
export function warn(msg) { console.error(`${c.yellow('!')} ${msg}`); }
export function error(msg) { console.error(`${c.red('✗')} ${msg}`); }

/** An error whose message is shown to the user without a stack trace. */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function time() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Renders console arguments forwarded from a page (`dev.log`) on one line. */
export function formatArgs(args) {
  return (Array.isArray(args) ? args : [args]).map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

const LEVEL_STYLE = {
  error: c.red,
  warn: c.yellow,
  info: c.cyan,
  debug: c.gray,
  log: (s) => s,
};

/** One line per page console entry: time, app id, level-coloured message. */
export function printPageLog({ level = 'log', args = [], ts, app }) {
  const style = LEVEL_STYLE[level] || LEVEL_STYLE.log;
  const stamp = ts ? new Date(ts) : new Date();
  const hh = [stamp.getHours(), stamp.getMinutes(), stamp.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const tag = level === 'log' ? '' : `${level} `;
  const who = app ? c.magenta(app) + ' ' : '';
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(`${c.gray(hh)} ${who}${style(tag + formatArgs(args))}`);
}

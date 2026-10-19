// A small argv parser: positionals, `--flag`, `--key value`, `--key=value`,
// `-k value`, and `--no-flag`. Each command declares its options so typos are
// caught instead of silently ignored.

import { CliError } from './log.js';

/**
 * @param {string[]} argv
 * @param {{ [name: string]: { type: 'string'|'boolean'|'number', alias?: string, default?: any } }} spec
 */
export function parseArgs(argv, spec = {}) {
  const opts = {};
  const positionals = [];
  const aliases = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.alias) aliases[def.alias] = name;
    if (def.default !== undefined) opts[name] = def.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }

    let name;
    let value;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else {
      name = aliases[arg.slice(1)] || arg.slice(1);
    }
    name = toCamel(name);

    let def = spec[name];
    if (!def && name.startsWith('no') && name.length > 2) {
      const base = name[2].toLowerCase() + name.slice(3);
      if (spec[base] && spec[base].type === 'boolean') { opts[base] = false; continue; }
    }
    if (!def) throw new CliError(`Unknown option ${arg}`);

    if (def.type === 'boolean') {
      opts[name] = value === undefined ? true : !/^(false|0|no)$/i.test(value);
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new CliError(`Option ${arg} needs a value`);
      value = argv[++i];
    }
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new CliError(`Option ${arg} needs a number, got "${value}"`);
      opts[name] = n;
    } else {
      opts[name] = value;
    }
  }
  return { opts, positionals };
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

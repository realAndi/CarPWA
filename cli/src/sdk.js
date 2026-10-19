// Locates the page SDK: the repository copy in ../sdk/js/ while developing,
// cli/vendor/ in the published package (filled by `npm run prepack`).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './log.js';

export const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CANDIDATES = [
  join(CLI_ROOT, '..', 'sdk', 'js'),
  join(CLI_ROOT, 'vendor'),
];

let cachedDir = null;

export function sdkDir() {
  if (cachedDir) return cachedDir;
  for (const dir of CANDIDATES) {
    if (existsSync(join(dir, 'carpwa.js'))) return (cachedDir = dir);
  }
  throw new CliError(`CarPWA SDK not found in ${CANDIDATES.join(' or ')}; run \`npm run prepack\` in cli/ to vendor it`);
}

/** @param {'carpwa.js'|'carpwa.d.ts'|'carpwa.css'} name */
export function sdkFile(name) {
  return readFileSync(join(sdkDir(), name));
}

export function sdkVersion() {
  const m = /var VERSION = '([^']+)'/.exec(sdkFile('carpwa.js').toString('utf8'));
  return m ? m[1] : '0.0.0';
}

/** The ESM flavour served at /_carpwa/sdk.mjs. */
export function sdkModule() {
  return Buffer.concat([sdkFile('carpwa.js'), Buffer.from('\nexport default globalThis.CarPWA;\n')]);
}

export function cliVersion() {
  try {
    return JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

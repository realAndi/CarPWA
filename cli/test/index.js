// `node --test cli/test`: Node ≥ 21 runs a folder argument as a single file
// (this one), so it imports every *.test.js here. Older runners search the
// folder themselves and run this file on its own, where it does nothing.
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';

if (basename(process.argv[1] || '') !== 'index.js') {
  const here = new URL('.', import.meta.url);
  for (const file of readdirSync(here).filter((f) => f.endsWith('.test.js')).sort()) {
    await import(new URL(file, here));
  }
}

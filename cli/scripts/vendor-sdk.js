// Copies the page SDK into cli/vendor/ so the published package works without
// the surrounding repository.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, '..', 'sdk', 'js');
const to = join(root, 'vendor');

if (!existsSync(join(from, 'carpwa.js'))) {
  console.error(`vendor-sdk: ${from} not found; keeping the existing vendor/ copy`);
  process.exit(existsSync(join(to, 'carpwa.js')) ? 0 : 1);
}
mkdirSync(to, { recursive: true });
for (const name of ['carpwa.js', 'carpwa.d.ts', 'carpwa.css']) {
  copyFileSync(join(from, name), join(to, name));
  console.log(`vendor-sdk: ${name}`);
}

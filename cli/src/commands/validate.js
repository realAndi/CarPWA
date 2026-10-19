import { parseArgs } from '../args.js';
import { validateApp, printReport } from '../manifest.js';

export const help = `Usage: carpwa validate [dir] [--json] [--strict]

Checks carpwa.json and the files it points to (start page, icon) against the
manifest rules. Exits 1 when there are errors.

Options:
  --json     print the result as JSON
  --strict   treat warnings as errors`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, {
    json: { type: 'boolean' },
    strict: { type: 'boolean' },
  });
  const result = validateApp(positionals[0] || '.');
  if (opts.json) {
    console.log(JSON.stringify({
      valid: !result.errors.length,
      dir: result.dir,
      errors: result.errors,
      warnings: result.warnings,
      manifest: result.manifest,
    }, null, 2));
  } else {
    printReport(result, { verbose: true });
  }
  const failed = result.errors.length > 0 || (opts.strict && result.warnings.length > 0);
  return failed ? 1 : 0;
}

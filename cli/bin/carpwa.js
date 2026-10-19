#!/usr/bin/env node
import { main } from '../src/cli.js';
import { error, globals } from '../src/log.js';

main(process.argv.slice(2)).then(
  (code) => { if (typeof code === 'number') process.exitCode = code; },
  (err) => {
    // Failures end with one line; --verbose adds the details.
    const message = String((err && err.message) || err).split('\n')[0];
    error(message);
    if (globals.verbose && err && err.stack && err.name !== 'CliError') console.error(err.stack);
    process.exitCode = (err && err.exitCode) || 1;
  },
);

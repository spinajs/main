#!/usr/bin/env node
// Runs under the ts-node ESM loader (the `sim` script): the suites are TypeScript over the built packages.
import { main } from '../src/cli.ts';
import { SUITES } from '../suites/index.ts';

let code;
try {
  code = await main(process.argv.slice(2), SUITES);
} catch (err) {
  console.error(err);
  code = 1;
}
// open handles of a finished seed must not keep the process alive
process.exit(code);

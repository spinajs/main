/**
 * Settles mutants a Stryker run reports as survived: applies each one to the source by hand and runs the
 * given test command in a fresh process. Stryker's long-lived workers carry module state between mutants
 * ( ESM cannot be reloaded ), so a kill can depend on which mutants ran before; a fresh process cannot.
 * ts-node runs transpile-only, as Stryker's @ts-nocheck would: a mutant like `if (false)` breaks narrowing.
 * The source is restored after each mutant.
 *
 * Usage ( from the package directory )
 * -----
 *   node ../../scripts/coverage/check-mutants.mjs lost.json -- npx ts-mocha -p tsconfig.json --bail
 */

import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const lost = JSON.parse(readFileSync(args[0], 'utf8'));
const command = args.slice(args.indexOf('--') + 1);
let survived = 0;

for (const m of lost) {
  const original = readFileSync(m.file, 'utf8');
  const lines = original.split('\n');
  if (m.start.line !== m.end.line) {
    console.log(`${m.file}:${m.start.line} spans lines, check by hand`);
    continue;
  }
  // Stryker report columns are 1-based.
  const line = lines[m.start.line - 1];
  lines[m.start.line - 1] = line.slice(0, m.start.column - 1) + m.replacement + line.slice(m.end.column - 1);
  writeFileSync(m.file, lines.join('\n'));
  try {
    const run = spawnSync(command[0], command.slice(1), { shell: true, encoding: 'utf8', env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' } });
    const out = `${run.stdout}${run.stderr}`;
    const failing = /^\s+\d+ failing/m.test(out);
    const passing = /\d+ passing/.test(out);
    const verdict = failing ? `killed by ${/^\s+1\) (.*)$/m.exec(out)?.[1]?.trim() ?? '?'}` : passing ? 'SURVIVED' : `ERROR ${/(Exception|Error)[^\n]*/.exec(out)?.[0] ?? ''}`;
    if (!failing) survived++;
    console.log(`${m.file}:${m.start.line}:${m.start.column} ${m.mutator} -> ${JSON.stringify(m.replacement)}: ${verdict}`);
  } finally {
    writeFileSync(m.file, original);
  }
}
process.exit(survived ? 1 : 0);

#!/usr/bin/env node
/**
 * Type-instantiation budget of the typed query builder.
 *
 *   node test/types/budget.mjs                    compare with budget.json; exit 1 when the gate is on and a mode grew by more than 20%
 *   node test/types/budget.mjs --write            record the current counts, keeping the gate as it is
 *   node test/types/budget.mjs --write --enforce  record the current counts and turn the gate on
 *
 * A count is bench.types.ts minus bench-baseline.types.ts, so lib and model declarations do not dilute
 * the 20%. --singleThreaded because TypeScript 7 instantiates per checker and the default number of
 * checkers depends on the machine. The gate is off until O5 re-baselines (owner answer Q6).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const TSC = join(ROOT, 'node_modules/typescript-7/lib/tsc.js');
const TS_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules/typescript-7/package.json'), 'utf8')).version;
const BUDGET = join(HERE, 'budget.json');
// Next to tsconfig.json on purpose: the inherited `types: ["node", "mocha"]` resolves from the config's
// directory, and from os.tmpdir() that lookup leaves the repo and fails with TS2688.
const TEMP_CONFIG = join(HERE, '.budget.tsconfig.json');
const GROWTH = 1.2;
const MODES = { loose: [], strict: [join(HERE, 'strict/orm-strict.d.ts')] };
// Measured once by hand (Task 4 Step 4); not part of the workload.
const NOTES =
  'bench.types.ts leaves out class-to-interface assignability (const i: ISelectQueryBuilder<User[]> = User.all()): in strict mode it costs 7078 instantiations, once per program.';

function instantiations(files) {
  writeFileSync(TEMP_CONFIG, JSON.stringify({ extends: './tsconfig.json', include: [], files }));
  let out;
  try {
    out = execFileSync(process.execPath, [TSC, '-p', TEMP_CONFIG, '--extendedDiagnostics', '--singleThreaded'], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(`tsc failed on ${files.join(', ')}:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  } finally {
    rmSync(TEMP_CONFIG, { force: true });
  }
  const match = /^Instantiations:\s+(\d+)\s*$/m.exec(out);
  if (!match) throw new Error(`no Instantiations line in tsc output:\n${out}`);
  return Number(match[1]);
}

function measure() {
  const result = { typescript: TS_VERSION, notes: NOTES };
  for (const [mode, extra] of Object.entries(MODES)) {
    const bench = instantiations([...extra, join(HERE, 'bench.types.ts')]);
    const baseline = instantiations([...extra, join(HERE, 'bench-baseline.types.ts')]);
    result[mode] = bench - baseline;
  }
  return result;
}

const committed = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, 'utf8')) : undefined;
const current = measure();

if (process.argv.includes('--write')) {
  const enforce = process.argv.includes('--enforce') || committed?.enforce === true;
  const next = { typescript: current.typescript, notes: current.notes, enforce, loose: current.loose, strict: current.strict };
  writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`budget.json written: ${JSON.stringify(next)}`);
} else {
  if (!committed) throw new Error('budget.json is missing; run with --write first');
  if (committed.typescript !== current.typescript) {
    console.error(`budget.json was measured with TypeScript ${committed.typescript}, this is ${current.typescript}. Re-measure on the base branch with --write in its own commit.`);
    process.exit(1);
  }
  let over = false;
  for (const mode of Object.keys(MODES)) {
    const limit = Math.floor(committed[mode] * GROWTH);
    const ok = current[mode] <= limit;
    over ||= !ok;
    console.log(`${mode}: ${current[mode]} instantiations (budget ${committed[mode]}, limit ${limit}) ${ok ? 'ok' : 'OVER'}`);
  }
  if (!committed.enforce) console.log('gate off until the O5 re-baseline (budget.json enforce: false)');
  else if (over) process.exit(1);
}

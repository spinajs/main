/**
 * Mutant by mutant: what a Stryker run before pruning detected ( Killed or Timeout ) that the run after
 * does not. With --timeouts, a before-Timeout takes the status of its bail rerun ( see minimal-tests.mjs ),
 * so a mutant that only timed out from slowness does not count as detected. Mutants are matched by file,
 * location, mutator and replacement; ids differ between runs.
 *
 * Usage
 * -----
 *   node scripts/coverage/mutation-diff.mjs before.json after.json [--timeouts rerun.json] [--json lost.json]
 */

import { readFileSync, writeFileSync } from 'fs';

const [beforePath, afterPath, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const before = read(beforePath);
const after = read(afterPath);
const rerun = option('--timeouts') && read(option('--timeouts'));

const key = (file, m) => `${file}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}:${m.mutatorName}:${m.replacement}`;
const index = (report) => new Map(Object.entries(report.files).flatMap(([file, { mutants }]) => mutants.map((m) => [key(file, m), m])));
const afterOf = index(after);
const rerunOf = rerun ? index(rerun) : new Map();
const detected = (status) => status === 'Killed' || status === 'Timeout';

const lost = [];
let gained = 0;
let missing = 0;
for (const [file, { mutants }] of Object.entries(before.files)) {
  for (const m of mutants) {
    const k = key(file, m);
    const was = m.status === 'Timeout' ? (rerunOf.get(k)?.status ?? m.status) : m.status;
    const now = afterOf.get(k)?.status;
    if (now === undefined) missing++;
    else if (detected(was) && !detected(now)) lost.push({ file, start: m.location.start, end: m.location.end, mutator: m.mutatorName, replacement: m.replacement, before: was, after: now });
    else if (!detected(was) && detected(now)) gained++;
  }
}

console.log(`lost ${lost.length}, gained ${gained}${missing ? `, ${missing} mutants missing from the after run ( different mutate scope? )` : ''}`);
for (const l of lost) console.log(`  ${l.file}:${l.start.line}:${l.start.column} ${l.mutator} -> ${JSON.stringify(l.replacement)} ( ${l.before} -> ${l.after} )`);
if (option('--json')) writeFileSync(option('--json'), JSON.stringify(lost, null, 1));

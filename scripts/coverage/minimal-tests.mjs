/**
 * The smallest set of a package's tests that keeps its mutation result: every mutant some test killed
 * is still killed, and every mutant some test covered is still covered. Reads the Stryker JSON report of
 * a run with coverageAnalysis "perTest" and disableBail ( without disableBail Stryker records only the
 * first killer, and every other killer looks redundant ).
 *
 * Greedy set cover: repeatedly keep the test that kills the most still-unkilled mutants ( then covers
 * the most still-uncovered ones ).
 *
 * Kept regardless:
 *   - every test covering a Timeout mutant: Stryker does not say which one hung
 *   - tests that cover no mutant: they check what mutation cannot see ( packaging, exports, types )
 *   - tests whose name matches --keep ( known-answer vectors and the like )
 * Locality: a mutant that a test of its source file's home test file ( the one killing most of that
 * source file's mutants ) kills must stay killed from that file, not only by some distant test that
 * happens to run the code.
 *
 * Usage
 * -----
 *   node scripts/coverage/minimal-tests.mjs packages/util/reports/mutation/mutation.json [--json out.json] [--keep regex]
 */

import { readFileSync, writeFileSync } from 'fs';

const [reportPath, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const jsonOut = option('--json');
const keepPattern = option('--keep') && new RegExp(option('--keep'), 'i');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const tests = new Map();
for (const [file, { tests: list }] of Object.entries(report.testFiles ?? {})) {
  for (const t of list) tests.set(t.id, { id: t.id, name: t.name, file, kills: new Set(), covers: new Set() });
}

const mustKill = new Set();
const mustCover = new Set();
const killersOf = new Map();
const hangs = new Set();
for (const [file, { mutants }] of Object.entries(report.files)) {
  for (const m of mutants) {
    const key = `${file}#${m.id}`;
    const killers = m.status === 'Killed' ? (m.killedBy ?? []) : [];
    if (m.status === 'Timeout') for (const id of m.coveredBy ?? []) hangs.add(id);
    if (killers.length) mustKill.add(key);
    killersOf.set(key, killers);
    for (const id of killers) tests.get(id)?.kills.add(key);
    if (m.coveredBy?.length) mustCover.add(key);
    for (const id of m.coveredBy ?? []) tests.get(id)?.covers.add(key);
  }
}

// Home test file per source file; a home-killable mutant becomes "<key>@home", which only home tests satisfy.
const homeOf = new Map();
for (const file of Object.keys(report.files)) {
  const kills = new Map();
  for (const t of tests.values()) for (const k of t.kills) if (k.startsWith(file + '#')) kills.set(t.file, (kills.get(t.file) ?? 0) + 1);
  const home = [...kills].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (home) homeOf.set(file, home);
}
for (const key of [...mustKill]) {
  const home = homeOf.get(key.slice(0, key.lastIndexOf('#')));
  const local = killersOf.get(key).map((id) => tests.get(id)).filter((t) => t?.file === home);
  if (!local.length) continue;
  mustKill.add(key + '@home');
  for (const t of local) t.kills.add(key + '@home');
}

const kept = [...tests.values()].filter((t) => t.covers.size === 0 || hangs.has(t.id) || keepPattern?.test(t.name));
const unkilled = new Set(mustKill);
const uncovered = new Set(mustCover);
kept.forEach((t) => (t.kills.forEach((k) => unkilled.delete(k)), t.covers.forEach((k) => uncovered.delete(k))));
const candidates = new Set([...tests.values()].filter((t) => !kept.includes(t)));
for (;;) {
  let best;
  let bestScore = [0, 0];
  for (const t of candidates) {
    const score = [count(t.kills, unkilled), count(t.covers, uncovered)];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) [best, bestScore] = [t, score];
  }
  if (!best) break;
  kept.push(best);
  candidates.delete(best);
  best.kills.forEach((k) => unkilled.delete(k));
  best.covers.forEach((k) => uncovered.delete(k));
}

const keptIds = new Set(kept.map((t) => t.id));
const removable = [...tests.values()].filter((t) => !keptIds.has(t.id));
// Per removable test, the kept tests that kill the most of what it kills: what makes it redundant.
const why = (t) =>
  kept
    .map((k) => [k, count(t.kills, k.kills)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k.name} ( ${n}/${t.kills.size} )`);

const byFile = new Map();
for (const t of removable) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);

console.log(`${tests.size} tests, ${[...mustKill].filter((k) => !k.endsWith('@home')).length} mutants killed, ${mustCover.size} covered`);
console.log(`keep ${kept.length}, removable ${removable.length} ( ${((removable.length / tests.size) * 100).toFixed(1)}% )`);
for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${list.length}\t${file}`);

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        tests: tests.size,
        kept: kept.map((t) => ({ name: t.name, file: t.file, kills: t.kills.size })),
        removable: removable.map((t) => ({ name: t.name, file: t.file, kills: t.kills.size, covers: t.covers.size, redundantWith: why(t) })),
      },
      null,
      2,
    ),
  );
}

function count(set, of) {
  let n = 0;
  for (const k of set) if (of.has(k)) n++;
  return n;
}

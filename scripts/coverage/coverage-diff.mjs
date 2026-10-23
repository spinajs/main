/**
 * What line, function and branch coverage a pruned suite lost: compares two c8 / istanbul
 * coverage-final.json files ( c8 --reporter=json ) file by file, down to branch arms. Mutation testing
 * cannot see a guard whose removal changes no answer; this can.
 *
 * c8 merges the coverage of a package's mocha processes unevenly, so two identical runs can differ by a
 * few functions or branches. Pass several after runs: a point counts as lost only when none covers it.
 *
 * Usage
 * -----
 *   node scripts/coverage/coverage-diff.mjs before/coverage-final.json after/coverage-final.json [after2/...]
 */

import { readFileSync } from 'fs';

const [before, ...afters] = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, 'utf8')));
const at = (loc) => `${loc.start.line}:${loc.start.column}`;
let lost = 0;

// Hits per point, summed over the after runs.
const covered = (map, counts, keyOf) => {
  const out = new Map();
  for (const [id, item] of Object.entries(map)) {
    const k = keyOf(item);
    const c = counts[id];
    const prev = out.get(k);
    out.set(k, Array.isArray(c) ? c.map((n, i) => n + (prev?.[i] ?? 0)) : c + (prev ?? 0));
  }
  return out;
};
const merge = (maps) => maps.reduce((acc, m) => {
  for (const [k, v] of m) {
    const prev = acc.get(k);
    acc.set(k, Array.isArray(v) ? v.map((n, i) => n + (prev?.[i] ?? 0)) : v + (prev ?? 0));
  }
  return acc;
}, new Map());
const branchKey = (br) => `${at(br.loc)}:${br.type}`;

for (const [file, a] of Object.entries(before)) {
  const runs = afters.map((after) => after[file]).filter(Boolean);
  if (!runs.length) {
    console.log(`${file}: missing after`);
    continue;
  }
  const statements = merge(runs.map((b) => covered(b.statementMap, b.s, at)));
  for (const [id, loc] of Object.entries(a.statementMap)) {
    if (a.s[id] > 0 && !(statements.get(at(loc)) > 0)) (lost++, console.log(`${file}:${at(loc)} statement no longer run`));
  }
  const functions = merge(runs.map((b) => covered(b.fnMap, b.f, (fn) => at(fn.loc))));
  for (const [id, fn] of Object.entries(a.fnMap)) {
    if (a.f[id] > 0 && !(functions.get(at(fn.loc)) > 0)) (lost++, console.log(`${file}:${at(fn.loc)} function ${fn.name} no longer called`));
  }
  const branches = merge(runs.map((b) => covered(b.branchMap, b.b, branchKey)));
  for (const [id, br] of Object.entries(a.branchMap)) {
    const now = branches.get(branchKey(br));
    a.b[id].forEach((hits, arm) => {
      if (hits > 0 && !(now?.[arm] > 0)) (lost++, console.log(`${file}:${at(br.locations[arm] ?? br.loc)} ${br.type} arm ${arm} no longer taken`));
    });
  }
}

console.log(lost ? `${lost} coverage points lost` : 'no coverage lost');
process.exit(lost ? 1 : 0);

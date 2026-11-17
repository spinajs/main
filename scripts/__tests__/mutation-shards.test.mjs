import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTargets } from '../mutation/gate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WHOLE = 'stryker.config.json';
const { targets } = readTargets(fileURLToPath(new URL('../mutation/targets.json', import.meta.url)));
const strykerConfig = (pkg, file) => JSON.parse(readFileSync(join(ROOT, 'packages', pkg, file), 'utf8'));

// Stryker's reading of `mutate`: patterns apply in order, a `!` pattern removes what earlier ones added.
function mutatedFiles(pkg, patterns) {
  for (const p of patterns) assert.match(p, /^!?src\//, `${pkg}: mutate pattern ${p} must start with src/`);
  const all = readdirSync(join(ROOT, 'packages', pkg, 'src'), { recursive: true }).map((f) => `src/${f.split('\\').join('/')}`);
  const files = new Set();
  for (const p of patterns) {
    if (p.startsWith('!')) for (const f of [...files]) matchesGlob(f, p.slice(1)) && files.delete(f);
    else for (const f of all) if (matchesGlob(f, p)) files.add(f);
  }
  return files;
}

const sharded = [...new Set(targets.filter((t) => t.config !== WHOLE).map((t) => t.package))];

test('the engine and RBAC targets are sharded', () => {
  assert.deepEqual(sharded.sort(), ['authz', 'authz-rbac']);
});

// The whole-package stryker.config.json stays for local runs and triage, and is the set the shards must cover.
for (const pkg of sharded) {
  test(`the shards of ${pkg} cover its ${WHOLE} mutate set exactly once`, () => {
    const whole = mutatedFiles(pkg, strykerConfig(pkg, WHOLE).mutate);
    const shards = targets.filter((t) => t.package === pkg).map((t) => ({ name: t.name, files: mutatedFiles(pkg, strykerConfig(pkg, t.config).mutate) }));
    assert.ok(whole.size > 0);
    for (const s of shards) assert.ok(s.files.size > 0, `${s.name} mutates no file`);
    for (const [i, a] of shards.entries()) {
      for (const b of shards.slice(i + 1)) {
        assert.deepEqual([...a.files].filter((f) => b.files.has(f)), [], `${a.name} and ${b.name} both mutate these`);
      }
    }
    const union = new Set(shards.flatMap((s) => [...s.files]));
    assert.deepEqual([...whole].filter((f) => !union.has(f)), [], `no shard of ${pkg} mutates these`);
    assert.deepEqual([...union].filter((f) => !whole.has(f)), [], `shards of ${pkg} mutate these, ${WHOLE} does not`);
  });
}

// Two shards of one package run side by side in CI; the workflow uploads <package>/<report> as mutation-<target>/mutation.json.
test('every target config has its own report file named mutation.json and its own temp dir', () => {
  const reports = new Set();
  const temps = new Set();
  for (const t of targets) {
    const config = strykerConfig(t.package, t.config);
    const report = `${t.package}/${config.jsonReporter.fileName}`;
    assert.match(report, /\/mutation\.json$/, `${t.name}: the gate reads mutation.json`);
    assert.ok(!reports.has(report), `${t.name}: report ${report} is shared`);
    assert.ok(!temps.has(config.tempDirName), `${t.name}: tempDirName ${config.tempDirName} is shared`);
    reports.add(report);
    temps.add(config.tempDirName);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTargets } from '../mutation/gate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { targets } = readTargets(fileURLToPath(new URL('../mutation/targets.json', import.meta.url)));
const readJson = (pkg, file) => JSON.parse(readFileSync(join(ROOT, 'packages', pkg, file), 'utf8'));

// Stryker's mocha runner passes `grep` to Mocha#grep, which compiles a string as a RegExp source, and never reads `invert`.
const TIMING_GREP = '^(?!.*@timing)';

test('the timing grep drops titles tagged @timing and keeps the rest', () => {
  const grep = new RegExp(TIMING_GREP);
  assert.ok(!grep.test('engine/evaluate work budget a 40-level DAG finishes fast @timing'));
  assert.ok(grep.test('engine/evaluate work budget once the budget is spent a large DAG is UNKNOWN'));
});

for (const t of targets) {
  test(`${t.name}: its mocha config leaves the @timing tests out`, () => {
    const mocharc = readJson(t.package, readJson(t.package, t.config).mochaOptions.config);
    assert.equal(mocharc.grep, TIMING_GREP);
    assert.equal(mocharc.invert, undefined);
  });
}

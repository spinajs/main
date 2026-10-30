import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countSeverities, listAnalyzable, mapPool } from '../build-fragments.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages/compiler/test/fixtures');
const leaf = (dir) => dir.split(/[\\/]/).pop();

test('countSeverities tallies by severity', () => {
  assert.deepEqual(countSeverities([{ severity: 'error' }, { severity: 'warning' }, { severity: 'warning' }]), { error: 1, warning: 2, info: 0 });
});

test('listAnalyzable keeps only packages with package.json, tsconfig.build.json and src', () => {
  assert.deepEqual(listAnalyzable(FIXTURES).map(leaf).sort(), ['report-info', 'report-warning']);
  assert.deepEqual(listAnalyzable(FIXTURES, ['report-info']).map(leaf), ['report-info']);
});

test('mapPool bounds concurrency and keeps order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test('a package with analyzer warnings still gets a fragment and exits 0', () => {
  // Inside the repo so the fixture resolves @spinajs/http through the root node_modules.
  const cacheDir = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const tmp = mkdtempSync(join(cacheDir, 'build-fragments-'));
  try {
    cpSync(join(FIXTURES, 'report-warning'), join(tmp, 'report-warning'), { recursive: true });
    const run = spawnSync(process.execPath, ['scripts/build-fragments.mjs', '--packages-dir', tmp], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /report-warning \d+ms 0 error\(s\), 1 warning\(s\)/);
    const fragment = JSON.parse(readFileSync(join(tmp, 'report-warning/lib/manifest.fragment.json'), 'utf8'));
    assert.equal(fragment.package.name, 'report-warning');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

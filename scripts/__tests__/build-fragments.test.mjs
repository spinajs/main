import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeAll, countSeverities, listAnalyzable, mapPool, parseConcurrency } from '../build-fragments.mjs';

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

test('a crashing worker fails its package, is replaced and the pool continues', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'crash-worker-'));
  try {
    const workerFile = join(tmp, 'worker.mjs');
    writeFileSync(
      workerFile,
      `import { parentPort } from 'node:worker_threads';
parentPort.on('message', (dir) => {
  if (dir.endsWith('boom')) process.exit(3);
  if (dir.endsWith('throws')) throw new Error('kaput');
  parentPort.postMessage({ ok: true, result: { name: dir, ms: 1, counts: { error: 0, warning: 0, info: 0 }, diagnostics: [] } });
});
`,
    );
    const seen = [];
    const dirs = ['boom', 'a', 'throws', 'b', 'c'];
    const results = await analyzeAll(dirs, { concurrency: 1, workerFile, onResult: (r) => seen.push(r.name) });
    assert.equal(results.length, 5);
    assert.match(results[0].crash, /exited with code 3/);
    assert.equal(results[0].counts.error, 1);
    assert.match(results[2].crash, /kaput/);
    assert.deepEqual([results[1], results[3], results[4]].map((r) => r.crash), [undefined, undefined, undefined]);
    assert.deepEqual(seen, dirs);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseConcurrency accepts positive integers only', () => {
  assert.equal(parseConcurrency(undefined, 4), 4);
  assert.equal(parseConcurrency('3', 4), 3);
  for (const bad of ['abc', '0', '-1', '1.5', '']) assert.throws(() => parseConcurrency(bad, 4), /positive integer/);
});

test('--concurrency with a bad value exits 2 with a clear error', () => {
  const run = spawnSync(process.execPath, ['scripts/build-fragments.mjs', '--packages-dir', FIXTURES, '--concurrency', 'abc'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--concurrency must be a positive integer, got "abc"/);
});

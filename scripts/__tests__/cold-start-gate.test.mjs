import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalVerdicts, readTargets, summaryOf, verdictOf } from '../bench/cold-start-gate.mjs';
import { parseArgs } from '../bench/cold-start.mjs';

const floor = { name: 'framework floor', controllers: 1, routes: 5, mode: 'require', maxMedianMs: 450 };
const resultOf = (require, off = 2000) => ({ modes: { off: { medianMs: off, minMs: off - 50 }, require: { medianMs: require, minMs: require - 50 } } });

test('the shipped targets are the 4.x limits', () => {
  const { runs, reruns, targets } = readTargets(fileURLToPath(new URL('../bench/cold-start-targets.json', import.meta.url)));
  assert.ok(runs >= 30);
  assert.equal(reruns, 1);
  assert.deepEqual(
    targets.map((t) => [t.controllers, t.routes, t.mode, t.maxMedianMs]),
    [
      [1, 5, 'require', 450],
      [200, 5, 'require', 900],
    ],
  );
});

test('a target passes at its limit and fails above it, on its own mode only', () => {
  assert.equal(verdictOf(floor, resultOf(450)).pass, true);
  assert.equal(verdictOf(floor, resultOf(450.1)).pass, false);
  assert.equal(verdictOf(floor, resultOf(300, 5000)).pass, true);
  assert.throws(() => verdictOf(floor, { modes: { off: { medianMs: 1 } } }), /did not measure mode require/);
});

test('a target fails only when its rerun fails too', () => {
  const over = verdictOf(floor, resultOf(600));
  const under = verdictOf(floor, resultOf(400));
  assert.deepEqual(
    finalVerdicts([[under], [over, under], [over, over]]).map((v) => [v.pass, v.medianMs, v.attempts.length]),
    [
      [true, 400, 1],
      [true, 400, 2],
      [false, 600, 2],
    ],
  );
});

test('the summary names every attempt, the limit and the runner baseline', () => {
  const [verdict] = finalVerdicts([[verdictOf(floor, resultOf(600)), verdictOf(floor, resultOf(610))]]);
  const summary = summaryOf([verdict], { baselineMs: 41, runs: 30, node: 'v22.0.0' });
  assert.match(summary, /\| framework floor \| require \| 600 ms \(min 550\), rerun 610 ms \(min 560\) \| 450 ms \| \*\*FAIL\*\* \|/);
  assert.match(summary, /`node -e 0`, median of 30\): 41 ms/);
});

test('targets without a limit or with an unknown mode are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cold-start-targets-'));
  try {
    const file = join(dir, 'targets.json');
    for (const target of [{ ...floor, maxMedianMs: undefined }, { ...floor, mode: 'prefer' }]) {
      writeFileSync(file, JSON.stringify({ targets: [target] }));
      assert.throws(() => readTargets(file), /needs name, controllers, routes, mode/);
    }
    writeFileSync(file, JSON.stringify({ targets: [] }));
    assert.throws(() => readTargets(file), /lists no targets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bench takes the modes and the compile cache switch', () => {
  assert.deepEqual(parseArgs(['--modes', 'require', '--no-compile-cache', '--runs', '3']), {
    controllers: 200,
    routes: 5,
    runs: 3,
    modes: ['require'],
    compileCache: false,
    out: 'bench.json',
    keep: false,
  });
  assert.throws(() => parseArgs(['--modes', 'prefer']), /--modes takes a list of off, require/);
});

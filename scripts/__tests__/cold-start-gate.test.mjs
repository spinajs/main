import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineCandidate, finalVerdicts, hasCiNumbers, readBaseline, readTargets, regressionCheckOf, summaryOf, verdictOf } from '../bench/cold-start-gate.mjs';
import { updateBaseline } from '../bench/update-cold-start-baseline.mjs';
import { parseArgs } from '../bench/cold-start.mjs';

const floor = { name: 'framework floor', controllers: 1, routes: 5, mode: 'require', maxMedianMs: 450 };
const environment = { cpu: 'Test CPU @ 3.0GHz', cores: 4, node: 'v22.0.0', platform: 'linux-x64', nodeStartupMs: 41, calibrationMs: 12.5 };
const resultOf = (warm, cold = warm + 100) => ({ environment, modes: { require: { warm: { medianMs: warm, minMs: warm - 50 }, cold: { medianMs: cold, minMs: cold - 50 } } } });
const reportOnly = { enforceLimits: false, maxRegression: 0.15 };
const ciBaseline = { measuredOn: { ci: 'github-actions', cpu: 'Runner CPU', cores: 4, node: 'v22.0.0', calibrationMs: 13, runUrl: 'https://example.test/runs/1' }, targets: { 'framework floor': { warmMs: 600, coldMs: 700 } } };
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'cold-start-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the shipped targets keep the 4.x limits, switched off, and a 15% regression check', () => {
  const { runs, reruns, enforceLimits, maxRegression, targets } = readTargets(fileURLToPath(new URL('../bench/cold-start-targets.json', import.meta.url)));
  assert.ok(runs >= 30);
  assert.equal(reruns, 1);
  assert.equal(enforceLimits, false);
  assert.equal(maxRegression, 0.15);
  assert.deepEqual(
    targets.map((t) => [t.controllers, t.routes, t.mode, t.maxMedianMs]),
    [
      [1, 5, 'require', 450],
      [200, 5, 'require', 900],
    ],
  );
});

test('the shipped baseline holds numbers from a CI run or none at all', () => {
  const baseline = readBaseline(fileURLToPath(new URL('../bench/cold-start-baseline.json', import.meta.url)));
  if (Object.keys(baseline.targets).length > 0) assert.equal(hasCiNumbers(baseline), true);
  else assert.equal(baseline.measuredOn, null);
});

test('a median over the 4.x limit is reported, and fails only when the limits are enforced', () => {
  const over = verdictOf(floor, resultOf(500), reportOnly);
  assert.equal(over.limit.over, true);
  assert.equal(over.pass, true);
  assert.equal(verdictOf(floor, resultOf(450), { ...reportOnly, enforceLimits: true }).pass, true);
  assert.equal(verdictOf(floor, resultOf(450.1), { ...reportOnly, enforceLimits: true }).pass, false);
  assert.throws(() => verdictOf(floor, { environment, modes: { off: {} } }, reportOnly), /did not measure require/);
});

test('a target fails when its warm or its cold median is more than maxRegression over the baseline', () => {
  const baseline = ciBaseline.targets['framework floor'];
  const check = (warm, cold) => verdictOf(floor, resultOf(warm, cold), { ...reportOnly, baseline });
  assert.equal(check(690, 805).pass, true);
  assert.equal(check(690.1, 700).pass, false);
  assert.equal(check(600, 805.1).pass, false);
  assert.deepEqual(check(660, 700).regression.warm, { baselineMs: 600, change: 0.1, over: false });
  assert.equal(verdictOf(floor, resultOf(5000), reportOnly).regression, undefined);
});

test('the regression check waits for CI numbers and runs locally only against a baseline passed on purpose', () => {
  assert.match(regressionCheckOf({ measuredOn: null, targets: {} }, { onCi: true, explicit: false }).skipped, /no numbers from a CI run yet/);
  assert.match(regressionCheckOf({ ...ciBaseline, measuredOn: { ...ciBaseline.measuredOn, ci: 'local' } }, { onCi: true, explicit: true }).skipped, /no numbers from a CI run yet/);
  assert.match(regressionCheckOf(ciBaseline, { onCi: false, explicit: false }).skipped, /--baseline/);
  assert.equal(regressionCheckOf(ciBaseline, { onCi: true, explicit: false }).baseline, ciBaseline);
  assert.equal(regressionCheckOf(ciBaseline, { onCi: false, explicit: true }).baseline, ciBaseline);
});

test('a target fails only when its rerun fails too', () => {
  const baseline = ciBaseline.targets['framework floor'];
  const slow = verdictOf(floor, resultOf(800), { ...reportOnly, baseline });
  const fine = verdictOf(floor, resultOf(610), { ...reportOnly, baseline });
  assert.deepEqual(
    finalVerdicts([[fine], [slow, fine], [slow, slow]]).map((v) => [v.pass, v.warm.medianMs, v.attempts.length]),
    [
      [true, 610, 1],
      [true, 610, 2],
      [false, 800, 2],
    ],
  );
});

test('the summary shows both cache states, every attempt, the runner, the limit and the baseline change', () => {
  const baseline = ciBaseline.targets['framework floor'];
  const [verdict] = finalVerdicts([[verdictOf(floor, resultOf(800, 900), { ...reportOnly, baseline }), verdictOf(floor, resultOf(810, 910), { ...reportOnly, baseline })]]);
  const summary = summaryOf([verdict], { runs: 30, ...reportOnly, regression: { baseline: ciBaseline } });
  assert.match(summary, /report only/);
  assert.match(summary, /\| framework floor \| warm \| 800 ms \(min 750\), rerun 810 ms \(min 760\) \| 450 ms, over \(not enforced\) \| 600 ms \| \+35\.0% \| \*\*regressed\*\* \|/);
  assert.match(summary, /\| framework floor \| cold \| 900 ms \(min 850\), rerun 910 ms \(min 860\) \| - \| 700 ms \| \+30\.0% \| \*\*regressed\*\* \|/);
  assert.match(summary, /Test CPU @ 3\.0GHz, 4 cores/);
  assert.match(summary, /`node -e 0` 41 ms, calibration 12\.5 ms/);
  assert.match(summary, /Runner CPU, 4 cores, calibration 13 ms/);
});

test('the summary says why the regression check did not run', () => {
  const [verdict] = finalVerdicts([[verdictOf(floor, resultOf(800), reportOnly)]]);
  const summary = summaryOf([verdict], { runs: 30, ...reportOnly, regression: { skipped: 'the baseline holds no numbers from a CI run yet' } });
  assert.match(summary, /Regression check skipped: the baseline holds no numbers from a CI run yet/);
  assert.match(summary, /\| framework floor \| warm \| 800 ms \(min 750\) \| 450 ms, over \(not enforced\) \| - \| - \| pass \|/);
});

test('a run writes a baseline candidate that records where it was measured', () => {
  const [verdict] = finalVerdicts([[verdictOf(floor, resultOf(612.3, 701.9), reportOnly)]]);
  const candidate = baselineCandidate([verdict], { GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'spinajs/main', GITHUB_RUN_ID: '42', GITHUB_SHA: 'abc', GITHUB_REF_NAME: 'master' }, new Date('2026-11-03T00:00:00Z'));
  assert.deepEqual(candidate, {
    measuredOn: { ci: 'github-actions', runUrl: 'https://github.com/spinajs/main/actions/runs/42', commit: 'abc', ref: 'master', date: '2026-11-03T00:00:00.000Z', cpu: environment.cpu, cores: 4, node: 'v22.0.0', platform: 'linux-x64', calibrationMs: 12.5, nodeStartupMs: 41 },
    targets: { 'framework floor': { warmMs: 612.3, coldMs: 701.9 } },
  });
  assert.equal(baselineCandidate([verdict], {}, new Date()).measuredOn.ci, 'local');
});

test('the baseline is updated only from a candidate measured on CI', () => {
  withDir((dir) => {
    const target = join(dir, 'baseline.json');
    const candidate = join(dir, 'candidate.json');
    writeFileSync(target, JSON.stringify({ measuredOn: null, targets: {} }));
    writeFileSync(candidate, JSON.stringify({ ...ciBaseline, measuredOn: { ...ciBaseline.measuredOn, ci: 'local' } }));
    assert.throws(() => updateBaseline({ candidate, target }), /not measured on CI/);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { measuredOn: null, targets: {} });
    writeFileSync(candidate, JSON.stringify(ciBaseline));
    updateBaseline({ candidate, target });
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), ciBaseline);
  });
});

test('targets without a limit or with an unknown mode, and baselines without numbers, are refused', () => {
  withDir((dir) => {
    const file = join(dir, 'targets.json');
    for (const target of [{ ...floor, maxMedianMs: undefined }, { ...floor, mode: 'prefer' }]) {
      writeFileSync(file, JSON.stringify({ targets: [target] }));
      assert.throws(() => readTargets(file), /needs name, controllers, routes, mode/);
    }
    writeFileSync(file, JSON.stringify({ targets: [] }));
    assert.throws(() => readTargets(file), /lists no targets/);
    writeFileSync(file, JSON.stringify({ targets: [floor], maxRegression: 0 }));
    assert.throws(() => readTargets(file), /maxRegression/);
    writeFileSync(file, JSON.stringify({ measuredOn: { ci: 'github-actions' }, targets: { 'framework floor': { warmMs: 600 } } }));
    assert.throws(() => readBaseline(file), /warmMs and coldMs/);
    assert.deepEqual(readBaseline(join(dir, 'missing.json')), { measuredOn: null, targets: {} });
  });
});

test('the bench takes the modes and the compile cache states', () => {
  assert.deepEqual(parseArgs(['--modes', 'require', '--caches', 'warm,cold', '--runs', '3']), {
    controllers: 200,
    routes: 5,
    runs: 3,
    modes: ['require'],
    caches: ['warm', 'cold'],
    out: 'bench.json',
    keep: false,
  });
  assert.deepEqual(parseArgs(['--no-compile-cache']).caches, ['off']);
  assert.deepEqual(parseArgs([]).caches, ['warm']);
  assert.throws(() => parseArgs(['--modes', 'prefer']), /--modes takes a list of off, require/);
  assert.throws(() => parseArgs(['--caches', 'hot']), /--caches takes a list of warm, cold, off/);
});

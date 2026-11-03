import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineCandidate, finalVerdicts, hasCiNumbers, readBaseline, readTargets, regressionCheckOf, summaryOf, verdictOf } from '../bench/cold-start-gate.mjs';
import { parseArgs as parseUpdateArgs, runRefusal, updateBaseline } from '../bench/update-cold-start-baseline.mjs';
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

test('the summary never shows pass on a target that failed, even when no single cache failed every attempt', () => {
  const baseline = ciBaseline.targets['framework floor'];
  const warmOnly = verdictOf(floor, resultOf(700, 700), { ...reportOnly, baseline });
  const coldOnly = verdictOf(floor, resultOf(600, 820), { ...reportOnly, baseline });
  const [verdict] = finalVerdicts([[warmOnly, coldOnly]]);
  assert.equal(verdict.pass, false);
  const rows = summaryOf([verdict], { runs: 30, ...reportOnly, regression: { baseline: ciBaseline } })
    .split('\n')
    .filter((line) => line.startsWith('| framework floor'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.doesNotMatch(row, /\| pass \|$/);
  assert.match(rows[0], /\| \*\*failed\*\*: first run regressed, rerun ok \|$/);
  assert.match(rows[1], /\| \*\*failed\*\*: first run ok, rerun regressed \|$/);
});

test('a target missing from the baseline is reported as having none', () => {
  const b10 = { ...floor, name: 'B10' };
  const [verdict] = finalVerdicts([[verdictOf(b10, resultOf(800), reportOnly)]]);
  const summary = summaryOf([verdict], { runs: 30, ...reportOnly, regression: { baseline: ciBaseline } });
  assert.match(summary, /\| B10 \| warm \| 800 ms \(min 750\) \| 450 ms, over \(not enforced\) \| no baseline \| - \| pass \|/);
  assert.match(summary, /No baseline for B10, so its regression was not checked/);
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

test('the baseline update measures on the current branch, else v4, and takes numeric run ids only', () => {
  assert.deepEqual(parseUpdateArgs(['--latest'], { currentBranch: 'v4-p-4' }), { latest: true, branch: 'v4-p-4' });
  assert.deepEqual(parseUpdateArgs(['--latest'], { currentBranch: undefined }), { latest: true, branch: 'v4' });
  assert.deepEqual(parseUpdateArgs(['--latest', '--branch', 'v4'], { currentBranch: 'feature' }), { latest: true, branch: 'v4' });
  assert.deepEqual(parseUpdateArgs(['--run', '123456'], { currentBranch: 'v4' }), { run: '123456' });
  assert.deepEqual(parseUpdateArgs(['candidate.json'], { currentBranch: 'v4' }), { file: 'candidate.json' });
  for (const argv of [['--run', '--help'], ['--run', '12a'], ['--run'], ['--latest', '--branch'], []]) assert.throws(() => parseUpdateArgs(argv, { currentBranch: 'v4' }), /usage/);
});

test('the baseline is taken only from a push or workflow_dispatch run of the cold-start workflow of this repository', () => {
  const repo = { full_name: 'spinajs/main' };
  const run = { path: '.github/workflows/cold-start.yml', event: 'workflow_dispatch', head_branch: 'v4', repository: repo, head_repository: repo };
  assert.equal(runRefusal(run), undefined);
  assert.equal(runRefusal({ ...run, event: 'push' }), undefined);
  assert.match(runRefusal({ ...run, event: 'pull_request', head_repository: { full_name: 'someone/fork' } }), /pull_request/);
  assert.match(runRefusal({ ...run, event: 'pull_request' }), /pull_request/);
  assert.match(runRefusal({ ...run, event: 'pull_request_target' }), /pull_request_target/);
  assert.match(runRefusal({ ...run, head_repository: { full_name: 'someone/fork' } }), /someone\/fork/);
  assert.match(runRefusal({ ...run, head_repository: null }), /fork/);
  assert.match(runRefusal({ ...run, path: '.github/workflows/build.yml' }), /build\.yml/);
});

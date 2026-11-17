import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_FILE, baselineCandidate, countsOf, matrixOf, parseArgs, readBaseline, readTargets, reportsOf, scoreOf, summaryOf, survivorsOf, verdictOf } from '../mutation/gate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GATE = fileURLToPath(new URL('../mutation/gate.mjs', import.meta.url));
const engine = { name: 'authz-engine', package: 'authz', config: 'stryker.config.json', concurrency: 3, focus: ['src/engine/combinators.ts'] };
const mutant = (status, line = 1, extra = {}) => ({ id: String(line), mutatorName: 'ConditionalExpression', replacement: 'true', status, location: { start: { line, column: 5 }, end: { line, column: 9 } }, ...extra });
const reportOf = (files) => ({ schemaVersion: '2', files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { language: 'typescript', source: '', mutants }])) });
const statuses = (...list) => list.map((s, i) => mutant(s, i + 1));
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the shipped targets: five, a 2-point tolerance, configs that exist, focus on combinators.ts and eval/check.ts', () => {
  const { tolerance, targets } = readTargets(fileURLToPath(new URL('../mutation/targets.json', import.meta.url)));
  assert.equal(tolerance, 2);
  assert.deepEqual(
    targets.map((t) => t.name),
    ['authz-engine', 'authz-ir-eval', 'authz-rbac-model', 'authz-rebac-model', 'authz-abac-model'],
  );
  for (const t of targets) {
    assert.ok(existsSync(join(ROOT, 'packages', t.package, t.config)), `${t.package}/${t.config}`);
    for (const f of t.focus) assert.ok(existsSync(join(ROOT, 'packages', t.package, f)), `${t.package}/${f}`);
  }
  assert.deepEqual(targets.find((t) => t.name === 'authz-engine').focus, ['src/engine/combinators.ts']);
  assert.deepEqual(targets.find((t) => t.name === 'authz-ir-eval').focus, ['src/eval/check.ts']);
});

test('the shipped baseline is empty or holds a CI score for every target', () => {
  const baseline = readBaseline(fileURLToPath(new URL('../mutation/baseline.json', import.meta.url)));
  if (baseline.measuredOn === null) return assert.deepEqual(baseline.targets, {});
  assert.equal(baseline.measuredOn.ci, 'github-actions');
  const { targets } = readTargets(fileURLToPath(new URL('../mutation/targets.json', import.meta.url)));
  assert.deepEqual(Object.keys(baseline.targets).sort(), targets.map((t) => t.name).sort());
});

test('readTargets rejects a malformed or duplicated target and a missing tolerance', () => {
  withDir((dir) => {
    const file = join(dir, 'targets.json');
    const write = (v) => writeFileSync(file, JSON.stringify(v));
    write({ tolerance: 2, targets: [engine, engine] });
    assert.throws(() => readTargets(file), /listed twice/);
    write({ tolerance: 2, targets: [{ ...engine, name: 'Bad Name' }] });
    assert.throws(() => readTargets(file), /needs name/);
    write({ tolerance: 2, targets: [{ ...engine, concurrency: 0 }] });
    assert.throws(() => readTargets(file), /needs name/);
    write({ targets: [engine] });
    assert.throws(() => readTargets(file), /tolerance/);
  });
});

test('readBaseline: a missing file is empty, a score outside 0-100 is an error', () => {
  withDir((dir) => {
    assert.deepEqual(readBaseline(join(dir, 'none.json')), { measuredOn: null, targets: {} });
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ measuredOn: { ci: 'github-actions' }, targets: { 'authz-engine': { score: 101 } } }));
    assert.throws(() => readBaseline(join(dir, 'b.json')), /score from 0 to 100/);
  });
});

test('the score is (killed + timeout) / (killed + timeout + survived + no coverage), floored to two decimals', () => {
  const c = countsOf(reportOf({ 'src/a.ts': statuses('Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored', 'CompileError', 'RuntimeError') }));
  assert.deepEqual([c.Killed, c.Timeout, c.Survived, c.NoCoverage, c.Ignored, c.CompileError, c.RuntimeError, c.Pending], [2, 1, 1, 1, 1, 1, 1, 0]);
  assert.equal(scoreOf(c), 60);
  assert.equal(scoreOf(countsOf(reportOf({ 'src/a.ts': statuses('Killed', 'Killed', 'Survived') }))), 66.66);
  assert.equal(scoreOf({ Killed: 57, Timeout: 0, Survived: 43, NoCoverage: 0 }), 57);
  assert.equal(scoreOf(countsOf(reportOf({ 'src/a.ts': statuses('Ignored') }))), undefined);
  assert.throws(() => countsOf(reportOf({ 'src/a.ts': statuses('Exploded') })), /unknown mutant status Exploded/);
});

test('survivorsOf lists Survived and NoCoverage mutants of the focus files only, in source order', () => {
  const report = reportOf({
    'src\\engine\\combinators.ts': [mutant('Survived', 30), mutant('Killed', 10), mutant('NoCoverage', 12, { replacement: 'false' })],
    'src/engine/evaluate.ts': [mutant('Survived', 5)],
  });
  assert.deepEqual(
    survivorsOf(report, ['src/engine/combinators.ts']).map((s) => [s.file, s.line, s.replacement, s.status]),
    [
      ['src/engine/combinators.ts', 12, 'false', 'NoCoverage'],
      ['src/engine/combinators.ts', 30, 'true', 'Survived'],
    ],
  );
});

test('verdicts: no report, an unfinished run and no valid mutant fail; no baseline passes; the tolerance is inclusive', () => {
  const tenths = (killed) => reportOf({ 'src/a.ts': statuses(...Array(killed).fill('Killed'), ...Array(1000 - killed).fill('Survived')) });
  assert.match(verdictOf(engine, undefined, undefined, 2).reason, /no report/);
  assert.equal(verdictOf(engine, reportOf({ 'src/a.ts': statuses('Killed', 'Pending') }), undefined, 2).pass, false);
  assert.match(verdictOf(engine, reportOf({ 'src/a.ts': statuses('Ignored') }), undefined, 2).reason, /no valid mutants/);
  assert.equal(verdictOf(engine, tenths(700), undefined, 2).pass, true);
  assert.equal(verdictOf(engine, tenths(700), { score: 72 }, 2).pass, true);
  const failed = verdictOf(engine, tenths(699), { score: 72 }, 2);
  assert.equal(failed.pass, false);
  assert.equal(failed.delta, -2.1);
  assert.match(failed.reason, /2\.10 points below the baseline 72\.00/);
  assert.equal(verdictOf(engine, tenths(800), { score: 72 }, 2).delta, 8);
});

test('the summary has one row per target, says when nothing is gated, and lists focus survivors', () => {
  const v = verdictOf(engine, reportOf({ 'src/engine/combinators.ts': [mutant('Killed', 1), mutant('Survived', 50)] }), undefined, 2);
  const text = summaryOf([v, verdictOf({ ...engine, name: 'authz-ir-eval' }, undefined, undefined, 2)], { tolerance: 2, measuredOn: null });
  assert.match(text, /\| authz-engine \| 2 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 50\.00 \| no baseline \| - \| pass \|/);
  assert.match(text, /\| authz-ir-eval \|.*\*\*failed\*\*: no report/);
  assert.match(text, /holds no scores yet/);
  assert.match(text, /Survivors in authz-engine/);
  assert.match(text, /`src\/engine\/combinators\.ts:50:5` ConditionalExpression/);
});

test('the candidate is marked github-actions only on CI and keeps every scored target', () => {
  const v = verdictOf(engine, reportOf({ 'src/a.ts': statuses('Killed', 'Survived') }), undefined, 2);
  const now = new Date('2026-11-06T02:17:00Z');
  const env = { GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'spinajs/main', GITHUB_RUN_ID: '9', GITHUB_SHA: 'abc', GITHUB_REF_NAME: 'v4', GITHUB_EVENT_NAME: 'push' };
  const ci = baselineCandidate([v, verdictOf({ ...engine, name: 'x' }, undefined, undefined, 2)], env, now);
  assert.deepEqual(ci, { measuredOn: { ci: 'github-actions', runUrl: 'https://github.com/spinajs/main/actions/runs/9', commit: 'abc', ref: 'v4', event: 'push', date: '2026-11-06T02:17:00.000Z' }, targets: { 'authz-engine': { score: 50, valid: 2 } } });
  assert.equal(baselineCandidate([v], {}, now).measuredOn.ci, 'local');
});

test('matrix and arguments', () => {
  assert.deepEqual(matrixOf({ tolerance: 2, targets: [engine] }), [{ name: 'authz-engine', package: 'authz', config: 'stryker.config.json', concurrency: 3 }]);
  assert.throws(() => parseArgs([]), /--reports <dir> or --report/);
  assert.throws(() => parseArgs(['--reports', 'a', '--report', 'authz-engine=b.json']), /exclude each other/);
  assert.throws(() => parseArgs(['--report', 'nonsense']), /<target>=<mutation.json>/);
  assert.equal(parseArgs(['--matrix']).matrix, true);
});

test('reportsOf: --reports reads every target and leaves missing ones undefined; --report refuses an unknown target', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'mutation-authz-engine'));
    writeFileSync(join(dir, 'mutation-authz-engine', 'mutation.json'), JSON.stringify(reportOf({ 'src/a.ts': statuses('Killed') })));
    const all = reportsOf([engine, { ...engine, name: 'authz-ir-eval' }], { reportsDir: dir, reportPairs: [] });
    assert.equal(countsOf(all.get('authz-engine')).Killed, 1);
    assert.equal(all.has('authz-ir-eval'), true);
    assert.equal(all.get('authz-ir-eval'), undefined);
    assert.throws(() => reportsOf([engine], { reportPairs: [['nope', join(dir, 'x.json')]] }), /does not list/);
  });
});

test('the CLI exits 1 below the tolerance, 0 within it, and writes the candidate', () => {
  withDir((dir) => {
    const targets = join(dir, 'targets.json');
    writeFileSync(targets, JSON.stringify({ tolerance: 2, targets: [engine] }));
    mkdirSync(join(dir, 'reports', 'mutation-authz-engine'), { recursive: true });
    writeFileSync(join(dir, 'reports', 'mutation-authz-engine', 'mutation.json'), JSON.stringify(reportOf({ 'src/a.ts': statuses('Killed', 'Killed', 'Killed', 'Survived') })));
    const run = (score) => {
      writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ measuredOn: { ci: 'github-actions' }, targets: { 'authz-engine': { score, valid: 4 } } }));
      const env = { ...process.env };
      delete env.GITHUB_STEP_SUMMARY;
      delete env.GITHUB_ACTIONS;
      return spawnSync(process.execPath, [GATE, '--targets', targets, '--baseline', join(dir, 'baseline.json'), '--reports', join(dir, 'reports'), '--out-dir', join(dir, 'out')], { encoding: 'utf8', env });
    };
    assert.equal(run(77).status, 0);
    assert.equal(run(77.01).status, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out', CANDIDATE_FILE), 'utf8')).targets['authz-engine'].score, 75);
  });
});

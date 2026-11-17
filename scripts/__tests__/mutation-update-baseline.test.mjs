import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPOSITORY, nextBaseline, parseArgs, provenanceRefusal, runRefusal } from '../mutation/update-baseline.mjs';

const targets = [{ name: 'authz-engine' }, { name: 'authz-ir-eval' }];
const ci = { ci: 'github-actions', runUrl: 'https://github.com/spinajs/main/actions/runs/9', repository: 'spinajs/main', commit: 'abc', ref: 'refs/heads/v4', event: 'push', date: '2026-11-07T02:17:00.000Z' };
const candidate = (engine, ir = 80, measuredOn = ci) => ({ measuredOn, targets: { 'authz-ir-eval': { score: ir, valid: 900 }, 'authz-engine': { score: engine, valid: 9000 } } });
const empty = { measuredOn: null, targets: {} };
const current = { measuredOn: ci, targets: { 'authz-engine': { score: 70, valid: 9000 }, 'authz-ir-eval': { score: 80, valid: 900 } } };
const run = (extra = {}) => ({ path: '.github/workflows/mutation.yml', event: 'push', head_branch: 'v4', repository: { full_name: 'spinajs/main' }, head_repository: { full_name: 'spinajs/main' }, ...extra });
const next = (c, base = current, extra = {}) => nextBaseline({ candidate: c, current: base, targets, allowLower: [], branch: 'v4', ...extra });

test('arguments', () => {
  assert.equal(REPOSITORY, 'spinajs/main');
  assert.deepEqual(parseArgs(['--latest']), { latest: true, branch: 'v4', allowLower: [] });
  assert.deepEqual(parseArgs(['--latest', '--branch', 'v4-z-15-mutation-baseline']), { latest: true, branch: 'v4-z-15-mutation-baseline', allowLower: [] });
  assert.deepEqual(parseArgs(['--run', '123', '--allow-lower', 'authz-engine']), { run: '123', branch: 'v4', allowLower: ['authz-engine'] });
  assert.deepEqual(parseArgs(['--branch', 'master', '--run', '123']), { run: '123', branch: 'master', allowLower: [] });
  assert.deepEqual(parseArgs(['c.json']), { file: 'c.json', branch: 'v4', allowLower: [] });
  for (const bad of [[], ['--run', 'abc'], ['--latest', '--branch'], ['--latest', '--branch', 'a', '--branch', 'b'], ['--allow-lower'], ['-x'], ['a.json', 'b.json']]) assert.throws(() => parseArgs(bad), /usage/);
});

test('only push, workflow_dispatch and schedule runs of mutation.yml on this repository and branch may set the baseline', () => {
  assert.equal(runRefusal(run(), 'v4'), undefined);
  assert.equal(runRefusal(run({ event: 'schedule', head_branch: 'master' }), 'master'), undefined);
  assert.match(runRefusal(run({ event: 'pull_request' }), 'v4'), /pull_request/);
  assert.match(runRefusal(run({ path: '.github/workflows/cold-start.yml' }), 'v4'), /not of .github\/workflows\/mutation.yml/);
  assert.match(runRefusal(run({ repository: { full_name: 'fork/main' }, head_repository: { full_name: 'fork/main' } }), 'v4'), /belongs to fork\/main, not to spinajs\/main/);
  assert.match(runRefusal(run({ repository: undefined }), 'v4'), /belongs to an unknown repository/);
  assert.match(runRefusal(run({ head_repository: { full_name: 'fork/main' } }), 'v4'), /measured code of fork\/main, not of spinajs\/main/);
  assert.match(runRefusal(run({ head_branch: 'feature' }), 'v4'), /measured branch feature, not v4/);
  assert.match(runRefusal(run({ head_branch: undefined }), 'v4'), /measured branch \(none\), not v4/);
});

test('a candidate must name this repository, the branch and a run of it', () => {
  const at = (extra, options = {}) => provenanceRefusal({ ...ci, ...extra }, { branch: 'v4', ...options });
  assert.equal(at({}), undefined);
  assert.equal(at({}, { runId: '9' }), undefined);
  assert.match(provenanceRefusal({ ci: 'local' }, { branch: 'v4' }), /not measured on CI \(measuredOn.ci is "local"\)/);
  assert.match(provenanceRefusal(undefined, { branch: 'v4' }), /not measured on CI/);
  assert.match(at({ repository: undefined }), /measured in undefined, not in spinajs\/main/);
  assert.match(at({ repository: 'fork/main' }), /measured in "fork\/main", not in spinajs\/main/);
  assert.match(at({ ref: undefined }), /measured on undefined, not on refs\/heads\/v4/);
  assert.match(at({ ref: 'v4' }), /measured on "v4", not on refs\/heads\/v4/);
  assert.match(at({ ref: 'refs/tags/v4' }), /not on refs\/heads\/v4/);
  assert.match(at({ ref: 'refs/heads/feature' }), /measured on "refs\/heads\/feature"/);
  assert.match(at({ runUrl: undefined }), /run URL undefined is not a run of https:\/\/github.com\/spinajs\/main\/actions\/runs\/<id>/);
  assert.match(at({ runUrl: 'https://github.com/fork/main/actions/runs/9' }), /is not a run of/);
  assert.match(at({ runUrl: 'https://github.com/spinajs/main/actions/runs/9/attempts/2' }), /is not a run of/);
  assert.match(at({}, { runId: '10' }), /names run 9, not run 10/);
});

test('a candidate must come from CI, from this repository and branch, and score every target', () => {
  assert.throws(() => next({ ...candidate(70), measuredOn: { ci: 'local' } }, empty), /not measured on CI/);
  assert.throws(() => next(candidate(70, 80, { ...ci, ref: 'refs/heads/feature' }), empty), /not on refs\/heads\/v4/);
  assert.throws(() => next(candidate(70), empty, { runId: '10' }), /names run 9, not run 10/);
  assert.throws(() => next({ measuredOn: ci, targets: { 'authz-engine': { score: 70, valid: 1 } } }, empty), /no score for authz-ir-eval/);
});

test('the first baseline is the whole candidate, in targets.json order', () => {
  const first = next(candidate(91.5, 70), empty, { runId: '9' });
  assert.deepEqual(first, { measuredOn: ci, targets: { 'authz-engine': { score: 91.5, valid: 9000 }, 'authz-ir-eval': { score: 70, valid: 900 } } });
  assert.deepEqual(Object.keys(first.targets), ['authz-engine', 'authz-ir-eval']);
});

test('a new target is recorded without --allow-lower, and a replaced key leaves the baseline', () => {
  const old = { measuredOn: ci, targets: { 'authz-engine': { score: 90, valid: 9000 }, 'authz-retired': { score: 99, valid: 10 } } };
  assert.deepEqual(next(candidate(90, 40), old).targets, { 'authz-engine': { score: 90, valid: 9000 }, 'authz-ir-eval': { score: 40, valid: 900 } });
});

test('a raise or an equal score is written in targets.json order; a lower score needs --allow-lower', () => {
  const raised = next(candidate(73.5));
  assert.deepEqual(Object.keys(raised.targets), ['authz-engine', 'authz-ir-eval']);
  assert.equal(raised.targets['authz-engine'].score, 73.5);
  assert.deepEqual(raised.measuredOn, ci);
  assert.throws(() => next(candidate(69.9)), /authz-engine 69\.9 < 70.*--allow-lower/);
  assert.equal(next(candidate(69.9), current, { allowLower: ['authz-engine'] }).targets['authz-engine'].score, 69.9);
  assert.throws(() => next(candidate(69.9, 79), current, { allowLower: ['authz-engine'] }), /lower than the baseline: authz-ir-eval 79 < 80;/);
});

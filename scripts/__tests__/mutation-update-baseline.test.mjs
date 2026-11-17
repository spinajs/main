import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBaseline, parseArgs, runRefusal } from '../mutation/update-baseline.mjs';

const targets = [{ name: 'authz-engine' }, { name: 'authz-ir-eval' }];
const ci = { ci: 'github-actions', runUrl: 'https://github.com/spinajs/main/actions/runs/9', commit: 'abc', ref: 'v4', event: 'push', date: '2026-11-07T02:17:00.000Z' };
const candidate = (engine, ir = 80) => ({ measuredOn: ci, targets: { 'authz-ir-eval': { score: ir, valid: 900 }, 'authz-engine': { score: engine, valid: 9000 } } });
const empty = { measuredOn: null, targets: {} };
const current = { measuredOn: ci, targets: { 'authz-engine': { score: 70, valid: 9000 }, 'authz-ir-eval': { score: 80, valid: 900 } } };
const run = (extra = {}) => ({ path: '.github/workflows/mutation.yml', event: 'push', repository: { full_name: 'spinajs/main' }, head_repository: { full_name: 'spinajs/main' }, ...extra });

test('arguments', () => {
  assert.deepEqual(parseArgs(['--latest'], { currentBranch: undefined }), { latest: true, branch: 'v4', allowLower: [] });
  assert.deepEqual(parseArgs(['--latest', '--branch', 'v4-z-15-mutation-baseline'], { currentBranch: 'x' }), { latest: true, branch: 'v4-z-15-mutation-baseline', allowLower: [] });
  assert.deepEqual(parseArgs(['--run', '123', '--allow-lower', 'authz-engine'], { currentBranch: 'v4' }), { run: '123', allowLower: ['authz-engine'] });
  assert.deepEqual(parseArgs(['c.json'], { currentBranch: 'v4' }), { file: 'c.json', allowLower: [] });
  for (const bad of [[], ['--run', 'abc'], ['--latest', '--branch'], ['--allow-lower'], ['-x'], ['a.json', 'b.json']]) assert.throws(() => parseArgs(bad, { currentBranch: 'v4' }), /usage/);
});

test('only push, workflow_dispatch and schedule runs of mutation.yml on this repository may set the baseline', () => {
  assert.equal(runRefusal(run()), undefined);
  assert.equal(runRefusal(run({ event: 'schedule' })), undefined);
  assert.match(runRefusal(run({ event: 'pull_request' })), /pull_request/);
  assert.match(runRefusal(run({ path: '.github/workflows/cold-start.yml' })), /not of .github\/workflows\/mutation.yml/);
  assert.match(runRefusal(run({ head_repository: { full_name: 'fork/main' } })), /fork/);
});

test('a candidate must come from CI and score every target', () => {
  assert.throws(() => nextBaseline({ candidate: { ...candidate(70), measuredOn: { ci: 'local' } }, current: empty, targets, allowLower: [] }), /not measured on CI/);
  assert.throws(() => nextBaseline({ candidate: { measuredOn: ci, targets: { 'authz-engine': { score: 70, valid: 1 } } }, current: empty, targets, allowLower: [] }), /no score for authz-ir-eval/);
});

test('a raise or an equal score is written in targets.json order; a lower score needs --allow-lower', () => {
  const raised = nextBaseline({ candidate: candidate(73.5), current, targets, allowLower: [] });
  assert.deepEqual(Object.keys(raised.targets), ['authz-engine', 'authz-ir-eval']);
  assert.equal(raised.targets['authz-engine'].score, 73.5);
  assert.deepEqual(raised.measuredOn, ci);
  assert.throws(() => nextBaseline({ candidate: candidate(69.9), current, targets, allowLower: [] }), /authz-engine 69\.9 < 70.*--allow-lower/);
  assert.equal(nextBaseline({ candidate: candidate(69.9), current, targets, allowLower: ['authz-engine'] }).targets['authz-engine'].score, 69.9);
});

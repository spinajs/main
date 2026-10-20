import assert from 'node:assert/strict';
import 'mocha';

import { SYSTEM } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES, fixtureDsl, mergeFixtures, runBehaviour } from '../../src/index.js';
import type { BehaviourId, BehaviourSelector, Case, DecisionExpectation, FixturePart, Step } from '../../src/index.js';
import { ORACLE_FACETS, oracleHarness } from './oracle.js';
import { recorder } from './recorder.js';

// Every part the reference engine can run: the core parts of the rules the fixtures cover.
const ORACLE_PARTS: readonly BehaviourSelector[] = ['B01.core', 'B02.core', 'B03.core', 'B04.core', 'B05.core', 'B06.core', 'B07.core', 'B08.core', 'B09.core', 'B09.runAs', 'B14.core', 'B14.cache', 'B17.core', 'B22.core', 'B27.bus', 'B27.cache', 'B27.domains', 'B29.host', 'B36.core', 'B37.core', 'B39.core'];

runBehaviour(ORACLE_PARTS, () => oracleHarness());

const fixtures = mergeFixtures(BEHAVIOUR_FIXTURES);

const part = (id: BehaviourId, name: string): FixturePart => {
  const found = fixtures.get(id)?.parts.find((p) => p.name === name);
  assert.ok(found, `${id}.${name}`);
  return found;
};

const findCase = (p: FixturePart, name: string): Case => {
  const found = p.cases.find((c) => c.name === name);
  assert.ok(found, name);
  return found;
};

/** Runs one case of a part through the runner against the oracle; returns the test state. */
async function runOne(id: BehaviourId, p: FixturePart, c: Case) {
  const rec = recorder();
  runBehaviour([`${id}.${p.name}` as BehaviourSelector], () => oracleHarness(), { mocha: rec.mocha, fixtures: [fixtureDsl.fixture(id, [{ ...p, cases: [c] }])] });
  const results = await rec.run();
  assert.equal(results.length, 1);
  return results[0];
}

const withStep = (c: Case, index: number, step: Step): Case => ({ ...c, steps: c.steps.map((s, i) => (i === index ? step : s)) });

const withExpect = (c: Case, index: number, change: (e: DecisionExpectation) => DecisionExpectation): Case => {
  const s = c.steps[index] as { readonly expect: DecisionExpectation };
  return withStep(c, index, { ...s, expect: change(s.expect) } as Step);
};

describe('behaviour fixtures under the reference engine', () => {
  it('the oracle has the facets of every part it runs', () => {
    for (const sel of ORACLE_PARTS) {
      const [id, name] = sel.split('.') as [BehaviourId, string];
      for (const f of part(id, name).facets) assert.ok(ORACLE_FACETS.includes(f), `${sel} needs ${f}`);
    }
  });

  describe('a wrong expectation fails', () => {
    // `step`: which step the mutation targets, for a case mutated more than once.
    const MUTATIONS: readonly { readonly id: BehaviourId; readonly part: string; readonly case: string; readonly step?: number; readonly mutate: (c: Case) => Case }[] = [
      { id: 'B01', part: 'core', case: 'deny-overrides: no routed model has an opinion', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'model_error' })) },
      { id: 'B03', part: 'core', case: 'deny-overrides: a deny beats a permit', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, allowed: true, residual: 'TRUE' })) },
      { id: 'B03', part: 'core', case: 'deny-overrides: a conditional deny cuts the permit row by row (UNKNOWN stays out)', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, residual: { selects: ['r1', 'r3'] } })) },
      { id: 'B04', part: 'core', case: 'deny-overrides: a model that exceeds modelTimeoutMs denies with model_error, over a permit', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: { code: 'model_error', model: 'm2' } })) },
      { id: 'B36', part: 'core', case: 'deny-overrides: the lowest priority wins', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'slow' })) },
      { id: 'B14', part: 'cache', case: 'authz.cache.ttlSeconds bounds a decision without validUntil', mutate: (c) => withStep(c, 2, { calls: { model: 'm1', count: 2 } }) },
      { id: 'B05', part: 'core', case: 'rule 1: combine names a model the domain does not register', mutate: (c) => ({ ...c, boot: { throws: 'AuthzConfigError', message: ['phantom'] } }) },
      { id: 'B07', part: 'core', case: 'ceiling.reason replaces the code', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'ceiling' })) },
      { id: 'B17', part: 'core', case: 'read and write are the union over the permitting votes', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, fields: { ...e.fields, read: { denies: ['c'] } } })) },
      { id: 'B14', part: 'core', case: 'decision.validUntil is the earliest expiry among the permitting votes', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, validUntil: new Date(e.validUntil!.getTime() + 3_600_000) })) },
      { id: 'B37', part: 'core', case: "the agent gets the delegate's answer, and is the decision's actor", mutate: (c) => withExpect(c, 0, (e) => ({ ...e, actor: { type: 'user', id: 'u1' } })) },
      { id: 'B03', part: 'core', case: 'first-applicable: explain still evaluates every routed model', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, trace: false })) },
      { id: 'B22', part: 'core', case: "sync: 'never' makes filterNow return undefined, never a guess", mutate: (c) => withStep(c, 0, { filterNow: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: [] } }) },
      { id: 'B09', part: 'core', case: 'a SYSTEM check is audited', mutate: (c) => withStep(c, 1, { audit: { kind: 'system', count: 2 } }) },
      { id: 'B09', part: 'runAs', case: 'without a principal in the ALS, current() is UNATTENDED', mutate: (c) => withStep(c, 0, { current: SYSTEM }) },
      { id: 'B36', part: 'core', case: 'a model deny with priority 100 beats the ceiling (200)', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'out_of_scope' })) },
      { id: 'B36', part: 'core', case: "the core's delegate deny (200) beats the principal's own no_access (400)", mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'no_access' })) },
      { id: 'B17', part: 'core', case: 'a permitting vote without fields contributes every field, before hide and neverRead', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, fields: { read: { allows: ['b'] } } })) },
      { id: 'B17', part: 'core', case: 'authz.fields.neverRead from config is removed from read and write', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, fields: { write: { allows: ['secret'] } } })) },
      { id: 'B22', part: 'core', case: "sync: 'after-preload' preloaded for one principal makes filterNow for another return undefined", mutate: (c) => withStep(c, 1, { filterNow: { as: 'bob', permission: 'file:read', type: 'file' }, expect: { selects: ['r1'] } }) },
      { id: 'B22', part: 'core', case: "sync: 'after-preload' under inherit is gated on the delegate the models run with, not on the agent", mutate: (c) => withStep(c, 1, { filterNow: { as: 'bot', permission: 'file:read', type: 'file' }, expect: { selects: ['r1'] } }) },
      { id: 'B22', part: 'core', case: "sync: 'after-preload' under inherit is gated on the delegate the models run with, not on the agent", step: 3, mutate: (c) => withStep(c, 3, { filterNow: { as: 'bot', permission: 'file:read', type: 'file' }, expect: 'undefined' }) },
      { id: 'B22', part: 'core', case: "sync: 'after-preload' does not gate async checks without preload", mutate: (c) => withExpect(c, 0, (e) => ({ ...e, allowed: false })) },
      { id: 'B39', part: 'core', case: 'a ref to an ancestor node no resolver knows makes the vote indeterminate: deny model_error', mutate: (c) => withExpect(c, 1, (e) => ({ ...e, reason: 'no_access' })) },
      { id: 'B39', part: 'core', case: 'a type-level request reading scope.<type>.* for a type other than $global makes the vote indeterminate: deny model_error', mutate: (c) => withExpect(c, 0, (e) => ({ ...e, reason: 'no_access' })) },
      { id: 'B39', part: 'core', case: 'scope.<type>.* reads adapter scope attributes for adapter types', mutate: (c) => withExpect(c, 2, (e) => ({ ...e, reason: 'no_access' })) },
    ];

    for (const m of MUTATIONS) {
      it(`${m.id}.${m.part} ${m.case}${m.step === undefined ? '' : ` (step ${m.step})`}`, async () => {
        const p = part(m.id, m.part);
        const original = findCase(p, m.case);
        assert.equal((await runOne(m.id, p, original)).state, 'passed', 'the case as written passes');
        const mutated = await runOne(m.id, p, m.mutate(original));
        assert.equal(mutated.state, 'failed', 'the mutated case fails');
      });
    }
  });
});

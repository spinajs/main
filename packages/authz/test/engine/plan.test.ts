import * as chai from 'chai';
import 'mocha';

import { ALL_PLAN, combinePlans, nonePlan, readModelPlan, withinOf } from '../../src/engine/plan.js';
import type { PlanAnswer } from '../../src/engine/plan.js';
import { TRUE } from '../../src/index.js';
import type { ModelListPlan, PlanTerm, ResourceFilter } from '../../src/index.js';

const expect = chai.expect;

const t = (op: string, args: unknown = {}): PlanTerm => ({ op, args });
const ans = (model: string, plan: ModelListPlan): PlanAnswer => ({ model, plan });
const terms = (permit: PlanTerm[], deny: PlanTerm[] = [], validUntil?: Date): ModelListPlan => (validUntil ? { kind: 'terms', permit, deny, validUntil } : { kind: 'terms', permit, deny });

function deepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => deepFrozen(x, seen));
}

describe('access plan combination', () => {
  describe('combinePlans', () => {
    it('no answer at all is none with no_access (H16)', () => {
      expect(combinePlans([])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('abstentions alone are none with no_access', () => {
      expect(combinePlans([ans('a', { kind: 'abstain' }), ans('b', { kind: 'abstain' })])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('deny terms without any permit are none with no_access', () => {
      expect(combinePlans([ans('a', terms([], [t('x.deny')]))])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('concatenates the permit and deny terms in answer order', () => {
      const plan = combinePlans([ans('a', terms([t('a.1'), t('a.2')], [t('a.d')])), ans('b', { kind: 'abstain' }), ans('c', terms([t('c.1')], [t('c.d')]))]);
      expect(plan).to.deep.equal({ kind: 'filter', permit: [t('a.1'), t('a.2'), t('c.1')], deny: [t('a.d'), t('c.d')] });
    });

    it('one all makes the permit unfiltered and keeps every deny term', () => {
      expect(combinePlans([ans('a', { kind: 'all' }), ans('b', terms([t('b.1')], [t('b.d')]))])).to.deep.equal({ kind: 'filter', permit: 'all', deny: [t('b.d')] });
    });

    it('an all with deny terms is still an unfiltered permit, and its deny terms join the others', () => {
      const plan = combinePlans([ans('rbac', { kind: 'all', deny: [t('rbac.deny')] }), ans('abac', terms([t('abac.1')], [t('abac.d')]))]);
      expect(plan).to.deep.equal({ kind: 'filter', permit: 'all', deny: [t('rbac.deny'), t('abac.d')] });
    });

    it('a deny-all wins over every permit and names its model', () => {
      expect(combinePlans([ans('a', { kind: 'all' }), ans('b', { kind: 'deny-all', reason: { code: 'mfa_required' } })])).to.deep.equal({ kind: 'none', reason: { code: 'mfa_required', model: 'b' } });
    });

    it('of several deny-alls the lowest (priority, sortKey) reason wins', () => {
      const plan = combinePlans([ans('a', { kind: 'deny-all', reason: { code: 'no_access' } }), ans('b', { kind: 'deny-all', reason: { code: 'blocked', priority: 150 } }), ans('c', { kind: 'deny-all', reason: { code: 'x', priority: 900 } })]);
      expect(plan).to.deep.equal({ kind: 'none', reason: { code: 'blocked', priority: 150, model: 'b' } });
    });

    it('keeps the model a reason already names', () => {
      expect(combinePlans([ans('a', { kind: 'deny-all', reason: { code: 'x', model: 'inner' } })])).to.deep.equal({ kind: 'none', reason: { code: 'x', model: 'inner' } });
    });

    it('takes the earliest validUntil of the answers and the bounds', () => {
      const plan = combinePlans([ans('a', { kind: 'all', validUntil: new Date(3000) }), ans('b', terms([t('b')], [], new Date(2000)))], { validUntil: new Date(2500) });
      expect(plan).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date(2000) });
    });

    it('carries within from the bounds', () => {
      const within = [{ type: 'folder', id: 'f1' }];
      expect(combinePlans([ans('a', { kind: 'all' })], { within })).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], within });
    });

    it('returns a deeply frozen plan', () => {
      expect(deepFrozen(combinePlans([ans('a', terms([t('a', { k: [1] })], [t('d')]))], { within: [{ type: 'f', id: '1' }] }))).to.equal(true);
    });
  });

  describe('readModelPlan', () => {
    it('copies and freezes each kind', () => {
      const args = { subjects: ['user:1'] };
      const read = readModelPlan({ kind: 'terms', permit: [{ op: 'rbac.assignment', args }], deny: [], validUntil: new Date(5) });
      expect(read).to.deep.equal({ kind: 'terms', permit: [{ op: 'rbac.assignment', args: { subjects: ['user:1'] } }], deny: [], validUntil: new Date(5) });
      expect((read as { permit: readonly PlanTerm[] }).permit[0].args).to.not.equal(args);
      expect(deepFrozen(read)).to.equal(true);
      expect(readModelPlan({ kind: 'abstain' })).to.deep.equal({ kind: 'abstain' });
      expect(readModelPlan({ kind: 'all' })).to.deep.equal({ kind: 'all' });
      expect(readModelPlan({ kind: 'all', deny: [{ op: 'rbac.deny', args: {} }] })).to.deep.equal({ kind: 'all', deny: [{ op: 'rbac.deny', args: {} }] });
      expect(readModelPlan({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked' } })).to.deep.equal({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked' } });
    });

    it('refuses a malformed plan', () => {
      const bad: unknown[] = [null, {}, { kind: 'some' }, { kind: 'terms', permit: 'x', deny: [] }, { kind: 'terms', permit: [], deny: undefined }, { kind: 'terms', permit: [{ args: 1 }], deny: [] }, { kind: 'terms', permit: [{ op: 'x', args: () => 1 }], deny: [] }, { kind: 'deny-all' }, { kind: 'deny-all', reason: {} }, { kind: 'all', validUntil: 'tomorrow' }, { kind: 'all', deny: 'x' }];
      for (const raw of bad) expect(() => readModelPlan(raw), JSON.stringify(raw) ?? String(raw)).to.throw();
    });
  });

  it('withinOf reads TRUE as no restriction, under as its scopes and anything else as not expressible', () => {
    const f1 = { type: 'folder', id: 'f1' };
    expect(withinOf(TRUE)).to.equal(undefined);
    expect(withinOf({ op: 'under', scopes: [f1] })).to.deep.equal([f1]);
    const both = {
      op: 'and',
      args: [
        { op: 'under', scopes: [f1] },
        { op: 'under', scopes: [{ type: 'folder', id: 'f2' }] },
      ],
    } as ResourceFilter;
    expect(withinOf(both)).to.equal(null);
  });

  it('ALL_PLAN and nonePlan are frozen, and nonePlan copies the reason', () => {
    expect(ALL_PLAN).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
    expect(deepFrozen(ALL_PLAN)).to.equal(true);
    const reason = { code: 'x' };
    const none = nonePlan(reason);
    expect(none).to.deep.equal({ kind: 'none', reason: { code: 'x' } });
    expect((none as { reason: unknown }).reason).to.not.equal(reason);
    expect(deepFrozen(none)).to.equal(true);
  });
});

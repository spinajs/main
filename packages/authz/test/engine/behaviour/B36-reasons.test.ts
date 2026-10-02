import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { FirstApplicable } from '../../../src/engine/combinators.js';
import { selectDenyReason, staticTruths } from '../../../src/engine/reasons.js';
import { FALSE, TRUE } from '../../../src/index.js';
import type { DenyReason, Vote } from '../../../src/index.js';

const expect = chai.expect;

const vote = (model: string, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...extra });
const denying = (model: string, ...reasons: DenyReason[]): Vote => vote(model, { denyWhen: TRUE, denies: reasons.map((reason) => ({ when: TRUE, reason })) });

// Core part of B36, as the engine wires it: static truths, every routed model counted under deny-overrides.
const reasonOf = (votes: readonly Vote[], core: readonly DenyReason[] = [], algorithm = 'deny-overrides', deciding?: Vote): DenyReason => selectDenyReason({ core, votes, truths: votes.map(staticTruths), algorithm, deciding, subjectEvaluated: false });

const permutations = <T>(xs: readonly T[]): T[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

describe('B36: deny reasons do not depend on model or rule order', () => {
  it('B36: under deny-overrides every routed model counts and the lowest (priority, sortKey) wins in any model order', () => {
    const rbac = vote('rbac', { reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' } });
    const abac = denying('abac', { code: 'outside_hours', priority: 300 }, { code: 'agents_disabled', priority: 100 });
    const fs = denying('fs', { code: 'branch_locked', priority: 100, sortKey: 'main' });
    for (const order of permutations([rbac, abac, fs])) {
      expect(reasonOf(order)).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    }
  });

  it('B36: canvas C6 — agents_disabled (100) is reported before a ceiling out_of_scope (200)', () => {
    const abac = denying('abac', { code: 'agents_disabled', priority: 100 });
    const core: DenyReason[] = [{ code: 'out_of_scope', priority: 200 }];
    expect(reasonOf([abac], core)).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    expect(reasonOf([vote('rbac', { reason: { code: 'role_too_low' } })], core)).to.deep.equal({ code: 'out_of_scope', priority: 200 });
  });

  it('B36: a model_error ranks last, so a real reason from another model is reported', () => {
    const bad: Vote = { model: 'bad', permitWhen: FALSE, denyWhen: TRUE, error: 'timeout', cacheable: false };
    const rbac = vote('rbac', { reason: { code: 'role_too_low' } });
    for (const order of permutations([bad, rbac])) expect(reasonOf(order)).to.deep.equal({ code: 'role_too_low', model: 'rbac' });
  });

  it('B36: an indeterminate deciding vote (a normalized copy, not one of the votes) gives model_error', () => {
    const bad: Vote = { model: 'bad', permitWhen: TRUE, denyWhen: FALSE, error: 'boom', cacheable: false };
    const votes = [vote('rbac', { reason: { code: 'role_too_low' } }), bad];
    const combined = new FirstApplicable().combine(votes);
    expect(combined.deciding).not.to.equal(undefined);
    expect(reasonOf(votes, [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'model_error', model: 'bad' });
  });

  it('B36: under first-applicable the deciding vote alone gives the reason, whatever was evaluated after it', () => {
    const deciding = denying('acl', { code: 'blocked', priority: 600 });
    // Inapplicable, so not deciding; its reason would win if it counted.
    const before = vote('rbac', { reason: { code: 'role_too_low' } });
    const after = denying('abac', { code: 'agents_disabled', priority: 100 });
    const votes = [before, deciding, after];
    const combined = new FirstApplicable().combine(votes);
    expect(combined.deciding).to.equal(deciding);
    expect(reasonOf(votes, [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'blocked', priority: 600, model: 'acl' });
    expect(reasonOf([before, deciding], [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'blocked', priority: 600, model: 'acl' });
  });

  it('B36: random models, rules and orders give one reason (fast-check)', () => {
    const reasonArb = fc.record({ code: fc.constantFrom('a', 'b', 'role_too_low', 'ceiling'), priority: fc.integer({ min: 0, max: 5 }).map((n) => n * 100), sortKey: fc.constantFrom('x', 'y') }, { requiredKeys: ['code'] }) as fc.Arbitrary<DenyReason>;
    const voteArb = fc.record({ model: fc.constantFrom('m1', 'm2', 'm3'), denies: fc.array(reasonArb, { maxLength: 3 }), reason: fc.option(reasonArb, { nil: undefined }) });
    fc.assert(
      fc.property(fc.array(voteArb, { minLength: 1, maxLength: 4 }), fc.array(reasonArb, { maxLength: 2 }), (gen, core) => {
        const votes = gen.map((g) => (g.reason ? { ...denying(g.model, ...g.denies), reason: g.reason } : denying(g.model, ...g.denies)));
        const expected = reasonOf(votes, core);
        const reversed = reasonOf(
          [...votes].reverse().map((v) => ({ ...v, denies: v.denies && [...v.denies].reverse() })),
          [...core].reverse(),
        );
        expect(reversed).to.deep.equal(expected);
      }),
      { numRuns: 300 },
    );
  });
});

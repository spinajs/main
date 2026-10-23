import * as chai from 'chai';
import 'mocha';

import { BUILTIN_COMBINATORS, DenyOverrides, FirstApplicable, PermitOverrides, normalizeVote } from '../../src/engine/combinators.js';
import { Combinator, FALSE, TRUE } from '../../src/index.js';
import type { ResourceFilter, Vote } from '../../src/index.js';

const expect = chai.expect;

const FIELDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
type Field = (typeof FIELDS)[number];

const cmp = (field: Field): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value: true });
const vote = (permitWhen: ResourceFilter, denyWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model: 'm', permitWhen, denyWhen, cacheable: true, ...extra });

const denyOverrides = new DenyOverrides();
const permitOverrides = new PermitOverrides();
const firstApplicable = new FirstApplicable();
const ALL: readonly Combinator[] = [denyOverrides, permitOverrides, firstApplicable];

describe('engine/combinators', () => {
  describe('normalizeVote', () => {
    it('turns an error vote into a frozen indeterminate copy', () => {
      const input = vote(TRUE, FALSE, { model: 'rbac', error: 'boom', denies: [{ when: TRUE, reason: { code: 'x' } }], fields: { read: ['*'] }, roles: { project: 'owner' }, reason: { code: 'no_access' }, cacheable: false });
      const before = structuredClone(input);
      const out = normalizeVote(input);

      expect(out).to.not.equal(input);
      expect(Object.isFrozen(out)).to.equal(true);
      expect(out.permitWhen).to.equal(FALSE);
      expect(out.denyWhen).to.equal(TRUE);
      expect(out.error).to.equal('boom');
      expect(out.model).to.equal('rbac');
      expect(out.cacheable).to.equal(false);
      expect(out.reason).to.deep.equal({ code: 'no_access' });
      expect(Object.hasOwn(out, 'denies')).to.equal(false);
      expect(Object.hasOwn(out, 'fields')).to.equal(false);
      expect(Object.hasOwn(out, 'roles')).to.equal(false);
      expect(input).to.deep.equal(before);
      expect(Object.isFrozen(input)).to.equal(false);
    });
  });

  describe('built-ins', () => {
    it('are Combinator subclasses with the algorithm names', () => {
      expect(denyOverrides).to.be.instanceOf(Combinator);
      expect(permitOverrides).to.be.instanceOf(Combinator);
      expect(firstApplicable).to.be.instanceOf(Combinator);
      expect(denyOverrides.name).to.equal('deny-overrides');
      expect(permitOverrides.name).to.equal('permit-overrides');
      expect(firstApplicable.name).to.equal('first-applicable');
    });

    it('BUILTIN_COMBINATORS is a frozen array of one instance each', () => {
      expect(Object.isFrozen(BUILTIN_COMBINATORS)).to.equal(true);
      expect(BUILTIN_COMBINATORS.map((c) => c.name)).to.deep.equal(['deny-overrides', 'permit-overrides', 'first-applicable']);
      expect(BUILTIN_COMBINATORS[0]).to.be.instanceOf(DenyOverrides);
      expect(BUILTIN_COMBINATORS[1]).to.be.instanceOf(PermitOverrides);
      expect(BUILTIN_COMBINATORS[2]).to.be.instanceOf(FirstApplicable);
    });
  });

  describe('two concrete votes, all 16 P/D combinations', () => {
    const B = [true, false] as const;
    const f = (b: boolean): ResourceFilter => (b ? TRUE : FALSE);

    for (const p1 of B)
      for (const d1 of B)
        for (const p2 of B)
          for (const d2 of B) {
            it(`P1=${p1} D1=${d1} P2=${p2} D2=${d2}`, () => {
              const votes = [vote(f(p1), f(d1), { model: 'one' }), vote(f(p2), f(d2), { model: 'two' })];
              const expected = {
                'deny-overrides': (p1 || p2) && !(d1 || d2),
                'permit-overrides': (p1 && !d1) || (p2 && !d2),
                'first-applicable': (p1 && !d1) || (p2 && !d2 && !(p1 || d1)),
              };
              for (const c of ALL) expect(c.combine(votes).allow, c.name).to.equal(f(expected[c.name as keyof typeof expected]));

              const deciding = firstApplicable.combine(votes).deciding;
              expect(deciding).to.equal(p1 || d1 ? votes[0] : p2 || d2 ? votes[1] : undefined);
              expect(denyOverrides.combine(votes).deciding).to.equal(undefined);
              expect(permitOverrides.combine(votes).deciding).to.equal(undefined);
            });
          }
  });

  describe('residual votes', () => {
    const a = cmp('a');

    it('deciding is undefined when the first non-FALSE or(P, D) is a residual', () => {
      const votes = [vote(FALSE, FALSE), vote(a, FALSE), vote(TRUE, FALSE)];
      expect(firstApplicable.combine(votes).deciding).to.equal(undefined);
    });
  });
});

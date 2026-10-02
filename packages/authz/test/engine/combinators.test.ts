import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { BUILTIN_COMBINATORS, DenyOverrides, FirstApplicable, PermitOverrides, normalizeVote } from '../../src/engine/combinators.js';
import { Combinator, FALSE, TRUE, and, not } from '../../src/index.js';
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

// Kleene three-valued logic; undefined = UNKNOWN.
type Truth = boolean | undefined;
type Assignment = Readonly<Record<Field, Truth>>;

const kAnd = (xs: readonly Truth[]): Truth => (xs.some((x) => x === false) ? false : xs.some((x) => x === undefined) ? undefined : true);
const kOr = (xs: readonly Truth[]): Truth => (xs.some((x) => x === true) ? true : xs.some((x) => x === undefined) ? undefined : false);
const kNot = (x: Truth): Truth => (x === undefined ? undefined : !x);

function truth(f: ResourceFilter, env: Assignment): Truth {
  switch (f.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and':
      return kAnd(f.args.map((x) => truth(x, env)));
    case 'or':
      return kOr(f.args.map((x) => truth(x, env)));
    case 'not':
      return kNot(truth(f.arg, env));
    case 'cmp':
      return env[f.field as Field];
    default:
      throw new Error(`unexpected op ${f.op}`);
  }
}

const truthArb = fc.constantFrom<Truth>(true, false, undefined);
const assignmentArb: fc.Arbitrary<Assignment> = fc.record(Object.fromEntries(FIELDS.map((f) => [f, truthArb])) as Record<Field, fc.Arbitrary<Truth>>);

const { filter: filterArb } = fc.letrec<{ filter: ResourceFilter }>((tie) => ({
  filter: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom<ResourceFilter>(TRUE, FALSE),
    fc.constantFrom(...FIELDS).map(cmp),
    fc.array(tie('filter'), { minLength: 0, maxLength: 3 }).map((args): ResourceFilter => ({ op: 'and', args })),
    fc.array(tie('filter'), { minLength: 0, maxLength: 3 }).map((args): ResourceFilter => ({ op: 'or', args })),
    tie('filter').map((arg): ResourceFilter => ({ op: 'not', arg })),
  ),
}));

const voteArb = (indeterminate: fc.Arbitrary<boolean> = fc.boolean()): fc.Arbitrary<Vote> => fc.record({ model: fc.constantFrom('rbac', 'abac', 'x', 'y'), permitWhen: filterArb, denyWhen: filterArb, error: indeterminate }).map(({ model, permitWhen, denyWhen, error }) => vote(permitWhen, denyWhen, error ? { model, error: 'boom', denies: [{ when: TRUE, reason: { code: 'r' } }], fields: { read: ['a'] }, roles: { project: 'viewer' } } : { model }));
// About one vote in four is indeterminate.
const votesArb = fc.array(voteArb(fc.nat(3).map((n) => n === 0)), { maxLength: 5 });

// Indeterminate votes count as P = FALSE, D = TRUE.
const pd = (v: Vote, env: Assignment): [Truth, Truth] => (v.error !== undefined ? [false, true] : [truth(v.permitWhen, env), truth(v.denyWhen, env)]);

const reference = {
  'deny-overrides': (votes: readonly Vote[], env: Assignment): Truth => {
    const t = votes.map((v) => pd(v, env));
    return kAnd([kOr(t.map(([p]) => p)), kNot(kOr(t.map(([, d]) => d)))]);
  },
  'permit-overrides': (votes: readonly Vote[], env: Assignment): Truth => kOr(votes.map((v) => pd(v, env)).map(([p, d]) => kAnd([p, kNot(d)]))),
  'first-applicable': (votes: readonly Vote[], env: Assignment): Truth => {
    const t = votes.map((v) => pd(v, env));
    return kOr(t.map(([p, d], i) => kAnd([p, kNot(d), ...t.slice(0, i).map(([pj, dj]) => kNot(kOr([pj, dj])))])));
  },
} as const;

const RUNS = { numRuns: 300 };

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

    it('treats any non-undefined error as indeterminate', () => {
      for (const error of ['', 0, null, false] as unknown[]) {
        const out = normalizeVote(vote(TRUE, FALSE, { error: error as string }));
        expect(out.permitWhen).to.equal(FALSE);
        expect(out.denyWhen).to.equal(TRUE);
        expect(out.error).to.equal(error);
      }
    });

    it('returns a good vote as it is', () => {
      const good = vote(cmp('a'), FALSE, { fields: { read: ['x'] }, roles: { project: 'viewer' } });
      expect(normalizeVote(good)).to.equal(good);
      const explicitUndefined = vote(TRUE, FALSE, { error: undefined });
      expect(normalizeVote(explicitUndefined)).to.equal(explicitUndefined);
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

    it('give FALSE for no votes', () => {
      for (const c of ALL) {
        const r = c.combine([]);
        expect(r.allow, c.name).to.equal(FALSE);
        expect(r.deciding, c.name).to.equal(undefined);
      }
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
    const b = cmp('b');
    const c = cmp('c');
    const d = cmp('d');

    it('deny-overrides of P = a, D = b is and(a, not(b))', () => {
      expect(denyOverrides.combine([vote(a, b)]).allow).to.deep.equal({ op: 'and', args: [a, { op: 'not', arg: b }] });
    });

    it('deny-overrides ORs permits and denies across votes', () => {
      expect(denyOverrides.combine([vote(a, b), vote(c, d)]).allow).to.deep.equal(and({ op: 'or', args: [a, c] }, not({ op: 'or', args: [b, d] })));
    });

    it('permit-overrides is an OR of each vote’s permit minus its own deny', () => {
      expect(permitOverrides.combine([vote(a, b), vote(c, FALSE)]).allow).to.deep.equal({ op: 'or', args: [{ op: 'and', args: [a, { op: 'not', arg: b }] }, c] });
    });

    it('first-applicable guards later votes with the earlier ones being inapplicable', () => {
      expect(firstApplicable.combine([vote(a, b), vote(c, d)]).allow).to.deep.equal({
        op: 'or',
        args: [
          { op: 'and', args: [a, { op: 'not', arg: b }] },
          { op: 'and', args: [c, { op: 'not', arg: d }, { op: 'not', arg: { op: 'or', args: [a, b] } }] },
        ],
      });
    });

    it('first-applicable stops counting votes after one that always applies', () => {
      expect(firstApplicable.combine([vote(a, FALSE), vote(FALSE, TRUE), vote(c, FALSE)]).allow).to.deep.equal(a);
    });

    it('deciding is undefined when the first non-FALSE or(P, D) is a residual', () => {
      const votes = [vote(FALSE, FALSE), vote(a, FALSE), vote(TRUE, FALSE)];
      expect(firstApplicable.combine(votes).deciding).to.equal(undefined);
    });

    it('deciding skips leading inapplicable votes', () => {
      const votes = [vote(FALSE, FALSE, { model: 'x' }), vote(FALSE, TRUE, { model: 'y' }), vote(a, FALSE)];
      expect(firstApplicable.combine(votes).deciding).to.equal(votes[1]);
    });

    it('deciding is the normalized vote when the first applicable vote is indeterminate', () => {
      const votes = [vote(FALSE, FALSE), vote(a, FALSE, { model: 'bad', error: 'boom', roles: { p: 'r' } }), vote(TRUE, FALSE)];
      const r = firstApplicable.combine(votes);
      expect(r.allow).to.equal(FALSE);
      expect(r.deciding?.model).to.equal('bad');
      expect(r.deciding?.error).to.equal('boom');
      expect(r.deciding?.permitWhen).to.equal(FALSE);
      expect(r.deciding?.denyWhen).to.equal(TRUE);
      expect(r.deciding?.roles).to.equal(undefined);
    });

    it('simplifies non-simplified vote filters', () => {
      const raw: ResourceFilter = { op: 'and', args: [TRUE, { op: 'or', args: [a] }] };
      expect(denyOverrides.combine([vote(raw, { op: 'or', args: [] })]).allow).to.deep.equal(a);
    });
  });

  describe('properties', () => {
    it('B03: deny- and permit-overrides do not depend on vote order', () => {
      const arb = votesArb.chain((votes) => fc.tuple(fc.constant(votes), fc.shuffledSubarray(votes, { minLength: votes.length, maxLength: votes.length }), assignmentArb));
      fc.assert(
        fc.property(arb, ([votes, shuffled, env]) => {
          for (const c of [denyOverrides, permitOverrides]) {
            expect(truth(c.combine(shuffled).allow, env), c.name).to.equal(truth(c.combine(votes).allow, env));
          }
        }),
        RUNS,
      );
    });

    it('the combined residual has the reference Kleene truth of each algorithm', () => {
      fc.assert(
        fc.property(votesArb, assignmentArb, (votes, env) => {
          for (const c of ALL) {
            expect(truth(c.combine(votes).allow, env), c.name).to.equal(reference[c.name as keyof typeof reference](votes, env));
          }
        }),
        RUNS,
      );
    });

    it('B04: deny-overrides is FALSE with any indeterminate vote', () => {
      const arb = fc.tuple(votesArb, voteArb(fc.constant(true)), votesArb, assignmentArb);
      fc.assert(
        fc.property(arb, ([before, bad, after, env]) => {
          const allow = denyOverrides.combine([...before, bad, ...after]).allow;
          expect(allow).to.equal(FALSE);
          expect(truth(allow, env)).to.equal(false);
        }),
        RUNS,
      );
    });

    it('B04: permit-overrides ignores indeterminate votes', () => {
      fc.assert(
        fc.property(votesArb, assignmentArb, (votes, env) => {
          const good = votes.filter((v) => v.error === undefined);
          expect(truth(permitOverrides.combine(votes).allow, env)).to.equal(truth(permitOverrides.combine(good).allow, env));
        }),
        RUNS,
      );
    });

    it('B04: first-applicable is FALSE when the first vote is indeterminate', () => {
      fc.assert(
        fc.property(voteArb(fc.constant(true)), votesArb, assignmentArb, (bad, rest, env) => {
          const r = firstApplicable.combine([bad, ...rest]);
          expect(r.allow).to.equal(FALSE);
          expect(truth(r.allow, env)).to.equal(false);
          expect(r.deciding?.error).to.equal('boom');
        }),
        RUNS,
      );
    });

    it('first-applicable with every vote P = FALSE, D = FALSE is the constant FALSE', () => {
      const falseVotes = fc.array(fc.constantFrom<ResourceFilter>(FALSE, { op: 'or', args: [] }, { op: 'and', args: [FALSE, cmp('a')] }, { op: 'not', arg: TRUE }), { maxLength: 6 });
      fc.assert(
        fc.property(falseVotes, falseVotes, (ps, ds) => {
          const n = Math.min(ps.length, ds.length);
          const r = firstApplicable.combine(ps.slice(0, n).map((p, i) => vote(p, ds[i])));
          expect(r.allow).to.equal(FALSE);
          expect(r.deciding).to.equal(undefined);
        }),
        RUNS,
      );
    });

    it('never mutates the input', () => {
      fc.assert(
        fc.property(votesArb, (votes) => {
          const items = [...votes];
          const snapshot = structuredClone(votes);
          for (const c of ALL) c.combine(votes);
          for (const v of votes) normalizeVote(v);
          expect(votes).to.deep.equal(snapshot);
          expect(votes.length).to.equal(items.length);
          votes.forEach((v, i) => expect(v).to.equal(items[i]));
        }),
        RUNS,
      );
    });
  });
});

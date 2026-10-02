import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { FieldCombiner } from '../../src/engine/fields.js';
import { AuthzConfigError, FALSE, TRUE, and, compileFieldGlobs, not, or } from '../../src/index.js';
import type { FieldSet, ResourceFilter, Vote } from '../../src/index.js';

const expect = chai.expect;

const atom = (field: string): ResourceFilter => Object.freeze({ op: 'cmp', field, cmp: 'eq', value: 1 }) as ResourceFilter;
const vote = (model: string, permitWhen: ResourceFilter, denyWhen: ResourceFilter, fields?: FieldSet, error?: string): Vote => {
  const v: { -readonly [K in keyof Vote]: Vote[K] } = { model, permitWhen, denyWhen, cacheable: true };
  if (fields) v.fields = fields;
  if (error !== undefined) v.error = error;
  return Object.freeze(v);
};
const permitting = (fields?: FieldSet, model = 'p') => vote(model, TRUE, FALSE, fields);
const denying = (fields?: FieldSet, model = 'd') => vote(model, FALSE, TRUE, fields);
const allows = (globs: readonly string[], path: string) => compileFieldGlobs(globs).allows(path);

describe('FieldCombiner', () => {
  const none = new FieldCombiner({ neverRead: [] });

  describe('combine', () => {
    it('no contributor ⇒ empty read and write', () => {
      const r = none.combine('deny-overrides', [vote('n', FALSE, FALSE, { read: ['a'] })]);
      expect(r.read).to.deep.equal([]);
      expect(r.write).to.deep.equal([]);
      expect(Object.isFrozen(r)).to.equal(true);
      expect(Object.isFrozen(r.read)).to.equal(true);
      expect(Object.isFrozen(r.write)).to.equal(true);
      expect(none.combine('deny-overrides', []).read).to.deep.equal([]);
    });

    it('a contributor without fields reads and writes everything', () => {
      const r = none.combine('deny-overrides', [permitting()]);
      expect(r.read).to.deep.equal(['*']);
      expect(r.write).to.deep.equal(['*']);
    });

    it('a contributor with only read writes everything, and vice versa', () => {
      expect(none.combine('deny-overrides', [permitting({ read: ['a'] })])).to.deep.equal({ read: ['a'], write: ['*'] });
      expect(none.combine('deny-overrides', [permitting({ write: ['a'] })])).to.deep.equal({ read: ['*'], write: ['a'] });
    });

    it('unions the contributors', () => {
      const r = none.combine('deny-overrides', [permitting({ read: ['a'], write: ['x'] }, 'p1'), vote('p2', atom('k'), FALSE, { read: ['b.c'], write: ['y'] })]);
      expect(allows(r.read, 'a')).to.equal(true);
      expect(allows(r.read, 'b.c')).to.equal(true);
      expect(allows(r.read, 'b.d')).to.equal(false);
      expect(allows(r.write, 'x')).to.equal(true);
      expect(allows(r.write, 'y')).to.equal(true);
      expect(allows(r.write, 'a')).to.equal(false);
    });

    it('subtracts hide of every vote whose denyWhen is not FALSE, from read and write', () => {
      const r = none.combine('deny-overrides', [permitting({ read: ['*'], write: ['*'] }), vote('d', FALSE, atom('k'), { hide: ['secret', 'meta.*'] })]);
      expect(allows(r.read, 'name')).to.equal(true);
      expect(allows(r.read, 'secret')).to.equal(false);
      expect(allows(r.read, 'meta.x')).to.equal(false);
      expect(allows(r.write, 'secret')).to.equal(false);
      expect(allows(r.write, 'meta.x')).to.equal(false);
      expect(allows(r.write, 'name')).to.equal(true);
    });

    it('ignores hide of votes whose denyWhen is FALSE', () => {
      const r = none.combine('deny-overrides', [permitting({ read: ['*'], hide: ['secret'] })]);
      expect(allows(r.read, 'secret')).to.equal(true);
    });

    it('applies neverRead to read only', () => {
      const c = new FieldCombiner({ neverRead: ['Password', '*.Password'] });
      const r = c.combine('deny-overrides', [permitting()]);
      expect(allows(r.read, 'Password')).to.equal(false);
      expect(allows(r.read, 'user.Password')).to.equal(false);
      expect(allows(r.read, 'name')).to.equal(true);
      expect(r.write).to.deep.equal(['*']);
    });

    it('ignores indeterminate votes, their fields and their hide', () => {
      const bad = vote('x', TRUE, FALSE, { read: ['secret'], hide: ['name'] }, 'boom');
      expect(none.combine('deny-overrides', [bad])).to.deep.equal({ read: [], write: [] });
      const r = none.combine('deny-overrides', [permitting({ read: ['name'] }), bad]);
      expect(r.read).to.deep.equal(['name']);
    });

    it('keeps negations and segment wildcards from the contract algebra', () => {
      const r = none.combine('deny-overrides', [permitting({ read: ['A.*', '!A.secret'] }, 'p1'), permitting({ read: ['B'] }, 'p2')]);
      expect(allows(r.read, 'A.x')).to.equal(true);
      expect(allows(r.read, 'A.secret')).to.equal(false);
      expect(allows(r.read, 'B')).to.equal(true);
      expect(allows(r.read, 'C')).to.equal(false);
    });

    it('a contributor that negates a path does not take it from another contributor', () => {
      const r = none.combine('deny-overrides', [permitting({ read: ['*', '!X'] }, 'p1'), permitting({ read: ['X'] }, 'p2')]);
      expect(allows(r.read, 'X')).to.equal(true);
    });

    it('deny-overrides: a vote with permitWhen not FALSE contributes even when it also denies', () => {
      const r = none.combine('deny-overrides', [vote('pd', atom('a'), atom('b'), { read: ['x'] })]);
      expect(r.read).to.deep.equal(['x']);
    });

    it('permit-overrides: a vote whose permit is cancelled by its own deny does not contribute', () => {
      const self = vote('pd', TRUE, TRUE, { read: ['x'] });
      expect(none.combine('permit-overrides', [self])).to.deep.equal({ read: [], write: [] });
      expect(none.combine('deny-overrides', [self]).read).to.deep.equal(['x']);
      const partly = vote('pd', atom('a'), atom('b'), { read: ['x'] });
      expect(none.combine('permit-overrides', [partly]).read).to.deep.equal(['x']);
    });

    it('first-applicable: a vote after one that always applies does not contribute', () => {
      const votes = [permitting({ read: ['a'] }, 'p1'), permitting({ read: ['b'] }, 'p2')];
      expect(none.combine('first-applicable', votes).read).to.deep.equal(['a']);
      expect(none.combine('deny-overrides', votes).read).to.deep.equal(['a', 'b']);
    });

    it('first-applicable: a vote after a conditional one still contributes', () => {
      const r = none.combine('first-applicable', [vote('p1', atom('k'), FALSE, { read: ['a'] }), permitting({ read: ['b'] }, 'p2')]);
      expect(r.read).to.deep.equal(['a', 'b']);
    });

    it('first-applicable: a vote after a deny that always applies does not contribute', () => {
      const r = none.combine('first-applicable', [denying(undefined, 'd'), permitting({ read: ['b'] }, 'p2')]);
      expect(r).to.deep.equal({ read: [], write: [] });
    });

    it('first-applicable: an indeterminate vote stops later contributors', () => {
      const r = none.combine('first-applicable', [vote('x', FALSE, FALSE, undefined, 'boom'), permitting({ read: ['b'] })]);
      expect(r).to.deep.equal({ read: [], write: [] });
    });

    it('a custom algorithm uses the permitWhen rule only', () => {
      const r = none.combine('custom', [vote('pd', TRUE, TRUE, { read: ['x'] }), permitting({ read: ['y'] })]);
      expect(r.read).to.deep.equal(['x', 'y']);
    });

    it('treats an unsimplified FALSE as FALSE', () => {
      const unsimplifiedFalse: ResourceFilter = { op: 'and', args: [FALSE, atom('a')] };
      const r = none.combine('deny-overrides', [vote('n', unsimplifiedFalse, unsimplifiedFalse, { read: ['a'], hide: ['b'] }), permitting({ read: ['b'] })]);
      expect(r.read).to.deep.equal(['b']);
    });

    it('does not mutate the votes', () => {
      const read = ['a', 'b'];
      const fields = { read, hide: ['b'] };
      const v = { model: 'p', permitWhen: TRUE, denyWhen: TRUE, cacheable: true, fields };
      none.combine('deny-overrides', [v]);
      expect(read).to.deep.equal(['a', 'b']);
      expect(Object.isFrozen(read)).to.equal(false);
    });

    it('memo hits return equal frozen results', () => {
      const c = new FieldCombiner({ neverRead: ['Password'] });
      const votes = [permitting({ read: ['a', 'Password'] })];
      const first = c.combine('deny-overrides', votes);
      const second = c.combine('first-applicable', [permitting({ read: ['a', 'Password'] })]);
      expect(second).to.equal(first);
      expect(Object.isFrozen(second.read)).to.equal(true);
      expect(Object.isFrozen(second.write)).to.equal(true);
    });

    it('keeps working when the memo evicts', () => {
      const c = new FieldCombiner({ neverRead: [], memoSize: 2 });
      for (let round = 0; round < 2; round++) {
        for (const f of ['a', 'b', 'c', 'd']) expect(c.combine('deny-overrides', [permitting({ read: [f] })]).read).to.deep.equal([f]);
      }
      const off = new FieldCombiner({ neverRead: [], memoSize: 0 });
      expect(off.combine('deny-overrides', [permitting({ read: ['a'] })]).read).to.deep.equal(['a']);
      expect(off.combine('deny-overrides', [permitting({ read: ['a'] })]).read).to.deep.equal(['a']);
    });

    it('throws AuthzConfigError when the glob algebra exceeds its budget, also on a memo hit', () => {
      const heavy = Array.from({ length: 300 }, (_, i) => `!*.f${i}`);
      const many = Array.from({ length: 300 }, (_, i) => `M${i}.*`);
      const votes = [permitting({ read: ['*', ...heavy] }, 'p1'), permitting({ read: many }, 'p2')];
      expect(() => none.combine('deny-overrides', votes)).to.throw(AuthzConfigError, /too complex/);
      expect(() => none.combine('deny-overrides', votes)).to.throw(AuthzConfigError, /too complex/);
    });

    it('lets an invalid glob from a vote throw AuthzConfigError', () => {
      expect(() => none.combine('deny-overrides', [permitting({ read: ['a..b'] })])).to.throw(AuthzConfigError);
      expect(() => none.combine('deny-overrides', [permitting({ read: ['a'] }), vote('d', FALSE, TRUE, { hide: ['bad glob'] })])).to.throw(AuthzConfigError);
    });

    it('permit-overrides: votes after the first decided permit do not count (explain = check)', () => {
      const first = permitting({ read: ['Name'] }, 'a');
      expect(none.combine('permit-overrides', [first, permitting({ read: ['*'] }, 'b')]).read).to.deep.equal(['Name']);
      expect(none.combine('permit-overrides', [first, denying({ hide: ['Name'] }, 'b')]).read).to.deep.equal(['Name']);
    });

    it('permit-overrides: an indeterminate vote does not decide', () => {
      const r = none.combine('permit-overrides', [vote('x', TRUE, FALSE, undefined, 'boom'), permitting({ read: ['b'] })]);
      expect(r.read).to.deep.equal(['b']);
    });

    it('first-applicable: hide of votes after the deciding vote does not count (explain = check)', () => {
      const r = none.combine('first-applicable', [permitting({ read: ['*'] }, 'a'), denying({ hide: ['Name'] }, 'b')]);
      expect(r.read).to.deep.equal(['*']);
    });

    describe('bind', () => {
      const missing = atom('missing');
      // Mimics the engine binder: a missing ref is FALSE under an even number of not, TRUE under an odd number.
      const bind = (f: ResourceFilter): ResourceFilter => {
        const walk = (g: ResourceFilter, odd: boolean): ResourceFilter => {
          if (g === missing) return odd ? TRUE : FALSE;
          if (g.op === 'not') return not(walk(g.arg, !odd));
          if (g.op === 'and') return and(...g.args.map((a) => walk(a, odd)));
          if (g.op === 'or') return or(...g.args.map((a) => walk(a, odd)));
          return g;
        };
        return walk(f, false);
      };

      it('a vote whose permit binds to FALSE grants no fields', () => {
        const votes = [permitting({ read: ['Name'] }, 'rbac'), vote('abac', missing, FALSE, { read: ['*'] })];
        expect(none.combine('deny-overrides', votes, bind).read).to.deep.equal(['Name']);
        expect(none.combine('deny-overrides', votes).read).to.deep.equal(['*']);
        expect(none.combine('permit-overrides', [vote('abac', missing, FALSE, { read: ['*'] })], bind)).to.deep.equal({ read: [], write: [] });
        expect(none.combine('first-applicable', [vote('abac', missing, FALSE, { read: ['*'] })], bind)).to.deep.equal({ read: [], write: [] });
      });

      it('a missing ref in denyWhen keeps the hide (fail closed)', () => {
        const r = none.combine('deny-overrides', [permitting(undefined, 'rbac'), vote('abac', FALSE, missing, { hide: ['Salary'] })], bind);
        expect(allows(r.read, 'Salary')).to.equal(false);
        expect(allows(r.write, 'Salary')).to.equal(false);
      });

      it('a hide whose denyWhen binds to FALSE does not count', () => {
        const atom2 = atom('z');
        const never = (f: ResourceFilter) => (f.op === 'not' && f.arg === atom2 ? TRUE : f);
        const r = none.combine('deny-overrides', [permitting(undefined, 'rbac'), vote('abac', FALSE, atom2, { hide: ['Salary'] })], never);
        expect(r.read).to.deep.equal(['*']);
      });

      it('a throwing bind becomes AuthzConfigError', () => {
        const boom = () => {
          throw new Error('boom');
        };
        expect(() => none.combine('deny-overrides', [permitting()], boom)).to.throw(AuthzConfigError, /boom/);
      });

      it('a bind that returns a non-filter becomes AuthzConfigError', () => {
        expect(() => none.combine('deny-overrides', [permitting()], () => undefined as unknown as ResourceFilter)).to.throw(AuthzConfigError);
      });
    });

    it('rejects a list longer than the contract allows before building a memo key', () => {
      const long = Array.from({ length: 1001 }, (_, i) => `f${i}`);
      expect(() => none.combine('deny-overrides', [permitting({ read: long })])).to.throw(AuthzConfigError, /1000/);
    });

    it('does not memoise a key over the size cap', () => {
      const c = new FieldCombiner({ neverRead: [] });
      const big = Array.from({ length: 900 }, (_, i) => `field_${'x'.repeat(80)}_${i}`);
      const first = c.combine('deny-overrides', [permitting({ read: big })]);
      const second = c.combine('deny-overrides', [permitting({ read: big })]);
      expect(second).to.deep.equal(first);
      expect(second).to.not.equal(first);
    });

    it('throws AuthzConfigError for fields lists that are not string arrays', () => {
      expect(() => none.combine('deny-overrides', [permitting({ read: 'a' as unknown as string[] })])).to.throw(AuthzConfigError);
      expect(() => none.combine('deny-overrides', [permitting({ write: [1] as unknown as string[] })])).to.throw(AuthzConfigError);
    });
  });

  describe('constructor', () => {
    it('rejects an invalid neverRead', () => {
      expect(() => new FieldCombiner({ neverRead: ['bad glob'] })).to.throw(AuthzConfigError);
      expect(() => new FieldCombiner({ neverRead: 'Password' as unknown as string[] })).to.throw(AuthzConfigError);
    });

    it('rejects an invalid memoSize', () => {
      expect(() => new FieldCombiner({ neverRead: [], memoSize: -1 })).to.throw(AuthzConfigError);
      expect(() => new FieldCombiner({ neverRead: [], memoSize: 1.5 })).to.throw(AuthzConfigError);
    });

    it('copies neverRead', () => {
      const neverRead = ['Password'];
      const c = new FieldCombiner({ neverRead });
      neverRead.push('name');
      expect(allows(c.combine('deny-overrides', [permitting()]).read, 'name')).to.equal(true);
    });
  });

  describe('intersect', () => {
    it('keeps what both allow', () => {
      const r = none.intersect({ read: ['a', 'b'], write: ['*', '!x'] }, { read: ['b.*', 'c'], write: ['x', 'y'] });
      expect(allows(r.read, 'a')).to.equal(false);
      expect(allows(r.read, 'b')).to.equal(false);
      expect(allows(r.read, 'b.c')).to.equal(true);
      expect(allows(r.read, 'c')).to.equal(false);
      expect(allows(r.write, 'x')).to.equal(false);
      expect(allows(r.write, 'y')).to.equal(true);
      expect(Object.isFrozen(r)).to.equal(true);
      expect(Object.isFrozen(r.read)).to.equal(true);
    });

    it('with an empty side is empty', () => {
      expect(none.intersect({ read: ['*'], write: ['*'] }, { read: [], write: [] })).to.deep.equal({ read: [], write: [] });
    });

    it('agrees with both sides on random globs (fast-check)', () => {
      const pool = ['*', 'a', 'b', 'a.*', 'a.b', '!a', '!a.b', '*.b', '!*.b'];
      const paths = ['a', 'b', 'c', 'a.b', 'a.c', 'b.b', 'c.b', 'a.b.c'];
      const list = fc.array(fc.constantFrom(...pool), { maxLength: 4 });
      fc.assert(
        fc.property(list, list, fc.constantFrom(...paths), (a, b, path) => {
          const r = none.intersect({ read: a, write: b }, { read: b, write: a });
          const expected = allows(a, path) && allows(b, path);
          expect(allows(r.read, path)).to.equal(expected);
          expect(allows(r.write, path)).to.equal(expected);
        }),
        { numRuns: 300 },
      );
    });
  });

  describe('properties (fast-check)', () => {
    const pool = ['*', 'a', 'b', 'c', 'a.*', 'a.b', 'b.c', '*.b', '!a', '!a.b', '!*.b', '!b'];
    const paths = ['a', 'b', 'c', 'd', 'a.b', 'a.c', 'b.b', 'b.c', 'c.b', 'a.b.c'];
    const algorithms = ['deny-overrides', 'permit-overrides', 'first-applicable', 'custom'];
    const list = fc.array(fc.constantFrom(...pool), { maxLength: 4 });
    // T / F / X (the atom): with one atom, simplify decides these terms exactly like this three-valued table.
    type Sym = 'T' | 'F' | 'X';
    const symArb = fc.constantFrom<Sym>('T', 'F', 'X');
    const toFilter = (s: Sym): ResourceFilter => (s === 'T' ? TRUE : s === 'F' ? FALSE : atom('k'));
    const sAnd = (...xs: Sym[]): Sym => (xs.includes('F') ? 'F' : xs.every((x) => x === 'T') ? 'T' : 'X');
    const sOr = (...xs: Sym[]): Sym => (xs.includes('T') ? 'T' : xs.every((x) => x === 'F') ? 'F' : 'X');
    const sNot = (x: Sym): Sym => (x === 'T' ? 'F' : x === 'F' ? 'T' : 'X');
    const voteArb = fc.record({ p: symArb, d: symArb, read: fc.option(list, { nil: undefined }), hide: fc.option(list, { nil: undefined }), error: fc.boolean() });
    type Spec = { p: Sym; d: Sym; read?: string[]; hide?: string[]; error: boolean };
    const build = (specs: readonly Spec[]) =>
      specs.map((s, i) => {
        const fields: { read?: string[]; hide?: string[] } = {};
        if (s.read) fields.read = s.read;
        if (s.hide) fields.hide = s.hide;
        return vote(`m${i}`, toFilter(s.p), toFilter(s.d), fields, s.error ? 'boom' : undefined);
      });
    const decidingIndex = (algorithm: string, specs: readonly Spec[]): number =>
      specs.findIndex((s) => {
        const [p, d]: Sym[] = s.error ? ['F', 'T'] : [s.p, s.d];
        if (algorithm === 'permit-overrides') return sAnd(p, sNot(d)) === 'T';
        if (algorithm === 'first-applicable') return sOr(p, d) === 'T';
        return false;
      });

    it('read allows a path ⇔ a contributor reads it, no hide covers it and neverRead does not, for every algorithm', () => {
      fc.assert(
        fc.property(fc.constantFrom(...algorithms), fc.array(voteArb, { maxLength: 4 }), list, fc.constantFrom(...paths), (algorithm, specs, neverRead, path) => {
          const result = new FieldCombiner({ neverRead }).combine(algorithm, build(specs));
          const k = decidingIndex(algorithm, specs);
          let unapplied: Sym = 'T';
          let readable = false;
          let hidden = false;
          for (const s of k < 0 ? specs : specs.slice(0, k + 1)) {
            const [p, d]: Sym[] = s.error ? ['F', 'T'] : [s.p, s.d];
            if (!s.error) {
              const term = algorithm === 'permit-overrides' ? sAnd(p, sNot(d)) : algorithm === 'first-applicable' ? sAnd(p, sNot(d), unapplied) : p;
              if (term !== 'F') readable ||= allows(s.read ?? ['*'], path);
              if (d !== 'F') hidden ||= allows(s.hide ?? [], path);
            }
            unapplied = sAnd(unapplied, sNot(sOr(p, d)));
          }
          expect(allows(result.read, path)).to.equal(readable && !hidden && !allows(neverRead, path));
        }),
        { numRuns: 500 },
      );
    });

    it('votes after the deciding vote never change the result (explain = check)', () => {
      fc.assert(
        fc.property(fc.constantFrom('permit-overrides', 'first-applicable'), fc.array(voteArb, { minLength: 1, maxLength: 5 }), (algorithm, specs) => {
          const k = decidingIndex(algorithm, specs);
          fc.pre(k >= 0);
          const c = new FieldCombiner({ neverRead: [], memoSize: 0 });
          expect(c.combine(algorithm, build(specs))).to.deep.equal(c.combine(algorithm, build(specs.slice(0, k + 1))));
        }),
        { numRuns: 300 },
      );
    });
  });
});

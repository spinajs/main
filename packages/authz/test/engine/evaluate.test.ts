import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { defaultAttribute, evaluateResidual, matchGlob, matchLike, matchWildcard } from '../../src/engine/evaluate.js';
import type { SubjectEnv, Truth } from '../../src/engine/evaluate.js';
import { FALSE, TRUE, and, or, simplify } from '../../src/contracts/filter.js';
import { GLOBAL } from '../../src/contracts/resource.js';
import type { EvaluationContext, NativeFilter, Principal, RelationResolver, ResourceFilter, ResourceRef, ResourceType, Value } from '../../src/index.js';

const expect = chai.expect;

type CmpOp = Extract<ResourceFilter, { op: 'cmp' }>['cmp'];

const U = undefined;
const T = true;
const F = false;

const USER: Principal = Object.freeze({ type: 'user', id: 'u1', authenticated: true, source: 'session', attributes: Object.freeze({}) });
const REF: ResourceRef = Object.freeze({ type: 'doc', id: 'd1' });
const CTX = Object.freeze({ domain: 'test' }) as unknown as EvaluationContext;

interface EnvOptions {
  attribute?: (subject: unknown, field: string) => unknown;
  relations?: Record<string, Partial<RelationResolver> | undefined>;
  relation?: (type: ResourceType, name: string) => RelationResolver | undefined;
  ancestors?: (ref: ResourceRef) => Promise<readonly ResourceRef[] | null>;
  natives?: Record<string, Partial<NativeFilter>>;
  ref?: ResourceRef;
}

function env(o: EnvOptions = {}): SubjectEnv & { calls: { relation: unknown[][]; ancestors: number; native: unknown[][] } } {
  const calls = { relation: [] as unknown[][], ancestors: 0, native: [] as unknown[][] };
  return {
    calls,
    principal: USER,
    ref: o.ref ?? REF,
    ctx: CTX,
    attribute: o.attribute ?? defaultAttribute,
    relation(type, name) {
      calls.relation.push([type, name]);
      if (o.relation) return o.relation(type, name);
      return o.relations?.[`${type}#${name}`] as RelationResolver | undefined;
    },
    ancestors(ref) {
      calls.ancestors++;
      return o.ancestors ? o.ancestors(ref) : Promise.resolve([ref, GLOBAL]);
    },
    native(op) {
      calls.native.push([op]);
      return o.natives?.[op] as NativeFilter | undefined;
    },
  };
}

const cmp = (field: string, op: CmpOp, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value: value as Value });
const run = (f: ResourceFilter, subject: unknown, e: SubjectEnv = env()): Promise<Truth> => evaluateResidual(f, subject, e);
const show = (v: unknown): string => {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return 'fn';
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()})`;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  try {
    return v === undefined ? 'undefined' : JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// [attribute, value, expected]
type Row = readonly [unknown, unknown, Truth];

function table(op: CmpOp, rows: readonly Row[]): void {
  describe(`cmp ${op}`, () => {
    for (const [attr, value, expected] of rows) {
      it(`${show(attr)} ${op} ${show(value)} => ${show(expected)}`, async () => {
        expect(await run(cmp('x', op, value), { x: attr })).to.equal(expected);
      });
    }
  });
}

const ISO = '2026-01-02T03:04:05.000Z';
const DATE = new Date(ISO);
const BAD_DATE = new Date('nope');
const REF_VALUE = { ref: 'principal.id' };
const INCOMPARABLE: readonly unknown[] = [{ a: 1 }, [1], NaN, Infinity, -Infinity, 10n, Symbol('s'), () => 1];

describe('engine/evaluate', () => {
  describe('cmp operators', () => {
    table('eq', [
      [1, 1, T],
      [1, 2, F],
      ['a', 'a', T],
      ['a', 'b', F],
      ['a', 'A', F],
      [true, true, T],
      [true, false, F],
      [0, -0, T],
      // number vs canonical numeric string
      [42, '42', T],
      ['42', 42, T],
      [42, '43', F],
      [1.5, '1.5', T],
      [-3, '-3', T],
      [42, '042', U],
      [42, ' 42', U],
      [42, '42 ', U],
      [42, '4.2e1', U],
      [0, '-0', U],
      [42, 'abc', U],
      [42, '', U],
      // String(Number('NaN')) === 'NaN' yet NaN is not a comparable number
      [NaN, 'NaN', U],
      [42, 'NaN', U],
      [42, 'Infinity', U],
      // boolean vs 0/1
      [true, 1, T],
      [false, 0, T],
      [true, 0, F],
      [1, true, T],
      [0, false, T],
      [1, false, F],
      [true, 2, U],
      [false, -1, U],
      [true, '1', U],
      [true, 'true', U],
      ['1', true, U],
      // Date attribute => ISO string
      [DATE, ISO, T],
      [DATE, '2026-01-02', F],
      [DATE, 0, U],
      [BAD_DATE, ISO, U],
      // null / undefined attribute
      [null, 1, U],
      [undefined, 1, U],
      [null, null, U],
      [undefined, null, U],
      // null value
      [1, null, U],
      ['a', null, U],
      // unbound ref and malformed values
      [1, REF_VALUE, U],
      ['principal.id', REF_VALUE, U],
      [1, undefined, U],
      [1, [1], U],
      [1, { a: 1 }, U],
      [1, NaN, U],
      [1, Infinity, U],
      // incomparable attributes
      ...INCOMPARABLE.map((a): Row => [a, 1, U]),
      [[1], [1], U],
    ]);

    table('ne', [[1, 1, F], [1, 2, T], ['a', 'b', T], ['a', 'a', F], [true, false, T], [42, '42', F], [42, '43', T], [42, '042', U], [true, 1, F], [true, 0, T], [true, 2, U], [DATE, ISO, F], [DATE, 'x', T], [BAD_DATE, 'x', U], [null, 1, U], [undefined, 'a', U], [1, null, U], [1, REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, 1, U])]);

    table('lt', [
      [1, 2, T],
      [2, 1, F],
      [2, 2, F],
      [-1, 0, T],
      ['a', 'b', T],
      ['b', 'a', F],
      ['a', 'a', F],
      ['B', 'a', T],
      ['a', 'ab', T],
      // code point order, not UTF-16 unit order
      ['￿', '\u{10000}', T],
      ['\u{10000}', '￿', F],
      ['', '\u{1f600}', T],
      [9, '10', T],
      ['9', 10, T],
      [9, '010', U],
      ['9', '10', F],
      [true, false, U],
      [true, 1, U],
      [false, 1, U],
      [DATE, '2027', T],
      [DATE, '2025', F],
      [null, 1, U],
      [undefined, 1, U],
      [1, null, U],
      [1, REF_VALUE, U],
      [1, 'abc', U],
      ...INCOMPARABLE.map((a): Row => [a, 1, U]),
    ]);

    table('lte', [[1, 2, T], [2, 2, T], [3, 2, F], ['a', 'a', T], ['b', 'a', F], [2, '2', T], [true, true, U], [null, 1, U], [1, null, U], [1, REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, 1, U])]);

    table('gt', [[2, 1, T], [1, 2, F], [2, 2, F], ['b', 'a', T], ['\u{10000}', '￿', T], [10, '9', T], [true, false, U], [null, 1, U], [1, null, U], [1, REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, 1, U])]);

    table('gte', [[2, 1, T], [2, 2, T], [1, 2, F], ['a', 'a', T], ['a', 'b', F], [2, '2', T], [false, false, U], [null, 1, U], [1, null, U], [1, REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, 1, U])]);

    table('in', [
      [1, [1, 2], T],
      [3, [1, 2], F],
      ['a', ['a', 'b'], T],
      ['c', ['a', 'b'], F],
      [42, ['42'], T],
      ['42', [42], T],
      // OR of equalities: an element eq cannot compare makes the miss UNKNOWN
      [42, ['042'], U],
      [42, ['x'], U],
      [3, [1, 'x'], U],
      [42, ['x', 42], T],
      ['a', [1, 'a'], T],
      [true, [1], T],
      [false, [0, 5], T],
      [true, [0], F],
      [true, [2], U],
      [true, [0, 2], U],
      [DATE, [ISO], T],
      // F1 simplify rewrites `in []` to FALSE whatever the attribute
      [1, [], F],
      [null, [], F],
      [null, [1], U],
      [undefined, [1], U],
      // non-list values
      [1, 1, U],
      ['a', 'a', U],
      [1, null, U],
      [1, REF_VALUE, U],
      [1, [REF_VALUE], U],
      [1, [1, null], U],
      [1, [1, true], U],
      [1, [1, NaN], U],
      [1, [1, [1]], U],
      [1, undefined, U],
      // eslint-disable-next-line no-sparse-arrays
      [1, [1, , 2], U],
      ...INCOMPARABLE.map((a): Row => [a, [1], U]),
    ]);

    table('nin', [[1, [1, 2], F], [3, [1, 2], T], ['c', ['a', 'b'], T], [42, ['42'], F], [42, ['042'], U], [42, ['x'], U], [3, [1, 'x'], U], [42, ['x', 42], F], [true, [1], F], [true, [0], T], [true, [0, 2], U], [1, [], T], [null, [], T], [null, [1], U], [undefined, [1], U], [1, 1, U], [1, null, U], [1, REF_VALUE, U], [1, [1, null], U], ...INCOMPARABLE.map((a): Row => [a, [1], U])]);

    table('like', [['abc', 'abc', T], ['abc', 'a%', T], ['abc', '%c', T], ['abc', '%b%', T], ['abc', 'a_c', T], ['abc', '___', T], ['abc', '__', F], ['abc', 'A%', F], ['a/b', 'a%', T], ['a%c', 'a\\%c', T], ['abc', 'a\\%c', F], ['a_c', 'a\\_c', T], ['abc', 'a\\_c', F], ['a\\c', 'a\\\\c', T], ['abc', 'a\\bc', T], ['abc', 'abc\\', U], [null, 'a%', U], [undefined, '%', U], [1, '1', U], [DATE, '2026-%', T], ['abc', null, U], ['abc', 1, U], ['abc', REF_VALUE, U], ['abc', ['a%'], U], ...INCOMPARABLE.map((a): Row => [a, '%', U])]);

    table('glob', [['release/x', 'release/*', T], ['release/a/b', 'release/*', F], ['release/a/b', 'release/**', T], ['release/a/b', '**/b', T], ['a/b', '*', F], ['ab', '*', T], ['a?b', 'a?b', T], ['axb', 'a?b', F], ['a%b', 'a%b', T], ['axb', 'a%b', F], ['a_b', 'a_b', T], ['axb', 'a_b', F], ['a\\b', 'a\\b', T], ['A', 'a', F], [null, '*', U], [1, '*', U], ['a', null, U], ['a', REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, '**', U])]);

    table('wildcard', [['release/a/b', 'release/*', T], ['release/', 'release/*', T], ['releasex', 'release/*', F], ['abc', '*', T], ['', '*', T], ['a%c', 'a%c', T], ['abc', 'a%c', F], ['a_c', 'a_c', T], ['abc', 'a_c', F], ['a\\c', 'a\\c', T], ['ABC', 'abc', F], [null, '*', U], [1, '*', U], ['a', 1, U], ['a', REF_VALUE, U], ...INCOMPARABLE.map((a): Row => [a, '*', U])]);

    describe('null / notnull never UNKNOWN', () => {
      const cases: readonly [unknown, boolean][] = [[null, true], [undefined, true], [BAD_DATE, true], [0, false], ['', false], [false, false], [DATE, false], ...INCOMPARABLE.map((a): [unknown, boolean] => [a, false])];
      for (const [attr, isNull] of cases) {
        it(`${show(attr)}: null => ${isNull}, notnull => ${!isNull}`, async () => {
          expect(await run(cmp('x', 'null'), { x: attr })).to.equal(isNull);
          expect(await run(cmp('x', 'notnull'), { x: attr })).to.equal(!isNull);
        });
      }

      it('a missing field is null', async () => {
        expect(await run(cmp('x', 'null'), {})).to.equal(true);
        expect(await run(cmp('x', 'notnull'), {})).to.equal(false);
      });

      it('ignores the value, even an unbound ref', async () => {
        expect(await run(cmp('x', 'null', REF_VALUE), { x: null })).to.equal(true);
        expect(await run(cmp('x', 'notnull', REF_VALUE), { x: 1 })).to.equal(true);
      });
    });

    describe('attribute source', () => {
      it('reads through env.attribute with the node field', async () => {
        const seen: unknown[][] = [];
        const e = env({
          attribute: (s, f) => {
            seen.push([s, f]);
            return 7;
          },
        });
        const subject = { any: 1 };
        expect(await run(cmp('a.b', 'eq', 7), subject, e)).to.equal(true);
        expect(seen).to.deep.equal([[subject, 'a.b']]);
      });

      it('a throwing attribute reader is UNKNOWN, also for null/notnull', async () => {
        const e = env({
          attribute: () => {
            throw new Error('boom');
          },
        });
        expect(await run(cmp('x', 'eq', 1), {}, e)).to.equal(undefined);
        expect(await run(cmp('x', 'null'), {}, e)).to.equal(undefined);
        expect(await run(cmp('x', 'notnull'), {}, e)).to.equal(undefined);
      });

      it('a thenable attribute is UNKNOWN and its rejection is handled', async () => {
        const e = env({ attribute: () => Promise.reject(new Error('late')) });
        expect(await run(cmp('x', 'notnull'), {}, e)).to.equal(undefined);
        expect(await run(cmp('x', 'null'), {}, e)).to.equal(undefined);
        await new Promise((r) => setImmediate(r));
      });

      it('a Date subclass with an overridden toISOString still yields the real ISO string', async () => {
        class Sneaky extends Date {
          override toISOString(): string {
            return 'x';
          }
        }
        expect(await run(cmp('x', 'eq', ISO), { x: new Sneaky(ISO) })).to.equal(true);
        expect(await run(cmp('x', 'eq', 'x'), { x: new Sneaky(ISO) })).to.equal(false);
      });

      it('an object posing as a Date is incomparable', async () => {
        const fake = Object.create(Date.prototype);
        expect(await run(cmp('x', 'eq', ISO), { x: fake })).to.equal(undefined);
        expect(await run(cmp('x', 'notnull'), { x: fake })).to.equal(true);
      });
    });

    it('unknown cmp operator and malformed cmp nodes => UNKNOWN', async () => {
      expect(await run({ op: 'cmp', field: 'x', cmp: 'regex', value: '.*' } as unknown as ResourceFilter, { x: 'a' })).to.equal(undefined);
      expect(await run({ op: 'cmp', field: 1, cmp: 'null' } as unknown as ResourceFilter, {})).to.equal(undefined);
      expect(await run({ op: 'cmp', cmp: 'null' } as unknown as ResourceFilter, {})).to.equal(undefined);
      expect(await run({ op: 'cmp', field: 'x' } as unknown as ResourceFilter, { x: null })).to.equal(undefined);
    });
  });

  describe('matchers', () => {
    it('like: %, _, escapes, case-sensitive', () => {
      expect(matchLike('a%', 'abc')).to.equal(true);
      expect(matchLike('a_c', 'abc')).to.equal(true);
      expect(matchLike('a\\%', 'a%')).to.equal(true);
      expect(matchLike('a\\%', 'ab')).to.equal(false);
      expect(matchLike('ABC', 'abc')).to.equal(false);
      expect(matchLike('%', '')).to.equal(true);
      expect(matchLike('_', '')).to.equal(false);
      expect(matchLike('', '')).to.equal(true);
      expect(matchLike('', 'a')).to.equal(false);
    });

    it('like: `_` takes one code point, not one UTF-16 unit', () => {
      expect(matchLike('a_b', 'a\u{1f600}b')).to.equal(true);
      expect(matchLike('a__b', 'a\u{1f600}b')).to.equal(false);
    });

    it('like: a trailing escape is malformed => undefined', () => {
      expect(matchLike('a\\', 'a')).to.equal(undefined);
      expect(matchLike('a\\\\', 'a\\')).to.equal(true);
    });

    it('glob: * stops at /, ** crosses it', () => {
      expect(matchGlob('release/*', 'release/a')).to.equal(true);
      expect(matchGlob('release/*', 'release/a/b')).to.equal(false);
      expect(matchGlob('release/**', 'release/a/b')).to.equal(true);
      expect(matchGlob('**', '')).to.equal(true);
      expect(matchGlob('*/*', 'a/b')).to.equal(true);
      expect(matchGlob('*/*', 'a/b/c')).to.equal(false);
      expect(matchGlob('a***', 'a/b/c')).to.equal(true);
    });

    it('wildcard: * crosses /', () => {
      expect(matchWildcard('release/*', 'release/a/b')).to.equal(true);
      expect(matchWildcard('*', 'a/b/c')).to.equal(true);
      expect(matchWildcard('a*c', 'a/b/c')).to.equal(true);
      expect(matchWildcard('a*c', 'a/b/d')).to.equal(false);
    });

    it('pathological patterns finish fast', () => {
      const text = 'a'.repeat(10000);
      const started = Date.now();
      expect(matchWildcard('*a*a*a*a*a*a*a*a*b', text)).to.equal(false);
      expect(matchGlob('*a*a*a*a*a*a*a*a*b', text)).to.equal(false);
      expect(matchGlob('**a**a**a**a**a**a**a**a**b', text)).to.equal(false);
      expect(matchLike('%a%a%a%a%a%a%a%a%b', text)).to.equal(false);
      expect(matchLike('%a%a%a%a%a%a%a%a%', text)).to.equal(true);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('the work cap (|pattern| x |text| > 4,000,000) returns undefined', () => {
      const text = 'a'.repeat(10000);
      expect(matchWildcard('*'.repeat(400), text)).to.equal(true);
      expect(matchWildcard('*'.repeat(401), text)).to.equal(undefined);
      expect(matchGlob('*'.repeat(401), text)).to.equal(undefined);
      expect(matchLike('%'.repeat(401), text)).to.equal(undefined);
    });

    it('the work cap makes the comparison UNKNOWN', async () => {
      const text = 'a'.repeat(10000);
      expect(await run(cmp('x', 'wildcard', '*'.repeat(401)), { x: text })).to.equal(undefined);
      expect(await run(cmp('x', 'like', '%'.repeat(401)), { x: text })).to.equal(undefined);
      expect(await run(cmp('x', 'glob', '*'.repeat(401)), { x: text })).to.equal(undefined);
      expect(await run({ op: 'not', arg: cmp('x', 'glob', '*'.repeat(401)) }, { x: text })).to.equal(undefined);
    });
  });

  describe('relation', () => {
    const rel = (holds: RelationResolver['holds']): Partial<RelationResolver> => ({ type: 'doc', relation: 'owner', holds });

    it('looks the resolver up by the subject ref type and passes principal, ref, subject', async () => {
      const seen: unknown[][] = [];
      const e = env({
        relations: {
          'doc#owner': rel((p, r, s) => {
            seen.push([p, r, s]);
            return true;
          }),
        },
      });
      const subject = { id: 'd1' };
      expect(await run({ op: 'relation', relation: 'owner' }, subject, e)).to.equal(true);
      expect(e.calls.relation).to.deep.equal([['doc', 'owner']]);
      expect(seen).to.have.length(1);
      expect(seen[0][0]).to.equal(USER);
      expect(seen[0][1]).to.equal(REF);
      expect(seen[0][2]).to.equal(subject);
    });

    it('holds false => FALSE', async () => {
      expect(await run({ op: 'relation', relation: 'owner' }, {}, env({ relations: { 'doc#owner': rel(() => false) } }))).to.equal(false);
    });

    it('async resolver', async () => {
      expect(await run({ op: 'relation', relation: 'owner' }, {}, env({ relations: { 'doc#owner': rel(async () => true) } }))).to.equal(true);
      expect(await run({ op: 'relation', relation: 'owner' }, {}, env({ relations: { 'doc#owner': rel(async () => false) } }))).to.equal(false);
    });

    it('missing resolver => UNKNOWN', async () => {
      expect(await run({ op: 'relation', relation: 'editor' }, {}, env())).to.equal(undefined);
    });

    it('throwing or rejecting resolver => UNKNOWN', async () => {
      const throws = rel(() => {
        throw new Error('x');
      });
      expect(await run({ op: 'relation', relation: 'owner' }, {}, env({ relations: { 'doc#owner': throws } }))).to.equal(undefined);
      expect(await run({ op: 'relation', relation: 'owner' }, {}, env({ relations: { 'doc#owner': rel(async () => Promise.reject(new Error('x'))) } }))).to.equal(undefined);
    });

    it('throwing env.relation lookup => UNKNOWN', async () => {
      const e = env({
        relation: () => {
          throw new Error('x');
        },
      });
      expect(await run({ op: 'relation', relation: 'owner' }, {}, e)).to.equal(undefined);
    });

    it('non-boolean result => UNKNOWN', async () => {
      for (const v of [1, 0, 'true', null, undefined, {}, Promise.resolve(1)]) {
        const e = env({ relations: { 'doc#owner': rel(() => v as boolean) } });
        expect(await run({ op: 'relation', relation: 'owner' }, {}, e), show(v)).to.equal(undefined);
      }
    });

    it('malformed relation node => UNKNOWN', async () => {
      expect(await run({ op: 'relation' } as unknown as ResourceFilter, {}, env({ relations: { 'doc#owner': rel(() => true) } }))).to.equal(undefined);
      expect(await run({ op: 'relation', relation: 1 } as unknown as ResourceFilter, {}, env())).to.equal(undefined);
    });
  });

  describe('under', () => {
    const chain: readonly ResourceRef[] = [REF, { type: 'folder', id: 'f1' }, { type: 'org', id: 'o1' }, GLOBAL];
    const anc = () => Promise.resolve(chain);
    const under = (...scopes: unknown[]): ResourceFilter => ({ op: 'under', scopes } as unknown as ResourceFilter);

    it('id match on self or an ancestor', async () => {
      const e = env({ ancestors: anc });
      expect(await run(under({ type: 'folder', id: 'f1' }), {}, e)).to.equal(true);
      expect(await run(under({ type: 'doc', id: 'd1' }), {}, e)).to.equal(true);
      expect(await run(under({ type: 'folder', id: 'f2' }), {}, e)).to.equal(false);
      expect(await run(under({ type: 'org', id: 'f1' }), {}, e)).to.equal(false);
      expect(await run(under({ type: 'folder', id: 'f2' }, { type: 'org', id: 'o1' }), {}, e)).to.equal(true);
    });

    it('asks ancestors of env.ref', async () => {
      const seen: ResourceRef[] = [];
      const e = env({
        ancestors: (r) => {
          seen.push(r);
          return anc();
        },
      });
      await run(under({ type: 'org', id: 'o1' }), {}, e);
      expect(seen).to.deep.equal([REF]);
    });

    it('a type-only scope matches any node of that type', async () => {
      const e = env({ ancestors: anc });
      expect(await run(under({ type: 'folder' }), {}, e)).to.equal(true);
      expect(await run(under({ type: 'team' }), {}, e)).to.equal(false);
    });

    it('a null id on a scope counts as no id', async () => {
      const e = env({ ancestors: anc });
      expect(await run(under({ type: 'org', id: null }), {}, e)).to.equal(true);
    });

    it('a null id on an ancestor counts as no id', async () => {
      const e = env({ ancestors: () => Promise.resolve([{ type: 'folder', id: null } as unknown as ResourceRef, GLOBAL]) });
      expect(await run(under({ type: 'folder' }), {}, e)).to.equal(true);
      expect(await run(under({ type: 'folder', id: 'f1' }), {}, e)).to.equal(false);
    });

    it('GLOBAL matches everything that reports GLOBAL', async () => {
      expect(await run(under(GLOBAL), {}, env({ ancestors: anc }))).to.equal(true);
      expect(await run(under(GLOBAL), {}, env({ ancestors: () => Promise.resolve([REF]) }))).to.equal(false);
    });

    it('null ancestors => UNKNOWN', async () => {
      expect(await run(under(GLOBAL), {}, env({ ancestors: () => Promise.resolve(null) }))).to.equal(undefined);
    });

    it('throwing or rejecting ancestors => UNKNOWN', async () => {
      const sync = env({
        ancestors: () => {
          throw new Error('x');
        },
      });
      expect(await run(under(GLOBAL), {}, sync)).to.equal(undefined);
      expect(await run(under(GLOBAL), {}, env({ ancestors: () => Promise.reject(new Error('x')) }))).to.equal(undefined);
    });

    it('malformed ancestor lists => UNKNOWN', async () => {
      for (const list of [{}, 'x', [null], [{ id: 'x' }], [{ type: 'folder', id: 1 }]]) {
        const e = env({ ancestors: () => Promise.resolve(list as unknown as ResourceRef[]) });
        expect(await run(under({ type: 'folder' }), {}, e), show(list)).to.equal(undefined);
      }
    });

    it('empty scopes => FALSE without asking ancestors (as F1 simplify)', async () => {
      const e = env({ ancestors: () => Promise.resolve(null) });
      expect(await run(under(), {}, e)).to.equal(false);
      expect(e.calls.ancestors).to.equal(0);
    });

    it('malformed scopes => UNKNOWN', async () => {
      const e = env({ ancestors: anc });
      expect(await run({ op: 'under' } as unknown as ResourceFilter, {}, e)).to.equal(undefined);
      expect(await run({ op: 'under', scopes: GLOBAL } as unknown as ResourceFilter, {}, e)).to.equal(undefined);
      expect(await run(under(null), {}, e)).to.equal(undefined);
      expect(await run(under({ id: 'f1' }), {}, e)).to.equal(undefined);
      expect(await run(under({ type: 'folder', id: 1 }), {}, e)).to.equal(undefined);
      expect(await run(under(GLOBAL, 'x'), {}, e)).to.equal(undefined);
    });

    it('asks ancestors once per evaluation', async () => {
      const e = env({ ancestors: anc });
      await run({ op: 'and', args: [under({ type: 'org' }), under({ type: 'folder' }), under(GLOBAL)] }, {}, e);
      expect(e.calls.ancestors).to.equal(1);
    });
  });

  describe('native:*', () => {
    it('registered filter: true/false => TRUE/FALSE, receives args, subject, ref, ctx', async () => {
      const seen: unknown[][] = [];
      const e = env({
        natives: {
          'native:geo': {
            op: 'native:geo',
            matches: (args, subject, ref, ctx) => {
              seen.push([args, subject, ref, ctx]);
              return (args as { ok: boolean }).ok;
            },
          },
        },
      });
      const subject = { s: 1 };
      expect(await run({ op: 'native:geo', args: { ok: true } }, subject, e)).to.equal(true);
      expect(await run({ op: 'native:geo', args: { ok: false } }, subject, e)).to.equal(false);
      expect(seen[0]).to.deep.equal([{ ok: true }, subject, REF, CTX]);
      expect(seen[0][1]).to.equal(subject);
      expect(seen[0][3]).to.equal(CTX);
      expect(e.calls.native).to.deep.equal([['native:geo'], ['native:geo']]);
    });

    it('async filter', async () => {
      const e = env({ natives: { 'native:a': { op: 'native:a', matches: async () => true } } });
      expect(await run({ op: 'native:a' }, {}, e)).to.equal(true);
    });

    it('missing filter => UNKNOWN', async () => {
      expect(await run({ op: 'native:nope' }, {}, env())).to.equal(undefined);
    });

    it('throwing or rejecting filter => UNKNOWN', async () => {
      const e = env({
        natives: {
          'native:t': {
            op: 'native:t',
            matches: () => {
              throw new Error('x');
            },
          },
          'native:r': { op: 'native:r', matches: () => Promise.reject(new Error('x')) },
        },
      });
      expect(await run({ op: 'native:t' }, {}, e)).to.equal(undefined);
      expect(await run({ op: 'native:r' }, {}, e)).to.equal(undefined);
    });

    it('non-boolean result => UNKNOWN', async () => {
      for (const v of [1, 'true', null, undefined, {}]) {
        const e = env({ natives: { 'native:n': { op: 'native:n', matches: () => v as boolean } } });
        expect(await run({ op: 'native:n' }, {}, e), show(v)).to.equal(undefined);
      }
    });

    it('a throwing env.native lookup => UNKNOWN', async () => {
      const e = env();
      e.native = () => {
        throw new Error('x');
      };
      expect(await run({ op: 'native:x' }, {}, e)).to.equal(undefined);
    });
  });

  describe('Kleene logic', () => {
    // atoms with a known value: x=1 gives TRUE for eq 1, FALSE for eq 2, UNKNOWN for eq null
    const atom = (t: Truth): ResourceFilter => (t === true ? TRUE : t === false ? FALSE : cmp('x', 'eq', null));
    const values: readonly Truth[] = [T, F, U];
    const kAnd = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);
    const kOr = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === undefined || b === undefined ? undefined : false);

    for (const a of values) {
      it(`not ${show(a)}`, async () => {
        expect(await run({ op: 'not', arg: atom(a) }, { x: 1 })).to.equal(a === undefined ? undefined : !a);
      });
      for (const b of values) {
        it(`${show(a)} and/or ${show(b)}`, async () => {
          expect(await run({ op: 'and', args: [atom(a), atom(b)] }, { x: 1 })).to.equal(kAnd(a, b));
          expect(await run({ op: 'or', args: [atom(a), atom(b)] }, { x: 1 })).to.equal(kOr(a, b));
        });
      }
    }

    it('constants', async () => {
      expect(await run(TRUE, {})).to.equal(true);
      expect(await run(FALSE, {})).to.equal(false);
    });

    it('empty and/or are their units (as F1 simplify)', async () => {
      expect(await run({ op: 'and', args: [] }, {})).to.equal(true);
      expect(await run({ op: 'or', args: [] }, {})).to.equal(false);
    });

    it('short-circuits and/or', async () => {
      const e = env({ relations: { 'doc#owner': { holds: () => true } } });
      expect(await run({ op: 'and', args: [FALSE, { op: 'relation', relation: 'owner' }] }, {}, e)).to.equal(false);
      expect(await run({ op: 'or', args: [TRUE, { op: 'relation', relation: 'owner' }] }, {}, e)).to.equal(true);
      expect(e.calls.relation).to.deep.equal([]);
    });

    it('unknown ops and malformed nodes => UNKNOWN', async () => {
      const bad: unknown[] = [
        null,
        undefined,
        1,
        'true',
        {},
        { op: 1 },
        { op: 'xor', args: [TRUE] },
        { op: 'native' },
        { op: 'and' },
        { op: 'and', args: TRUE },
        { op: 'or', args: 'ab' },
        { op: 'not' },
        { op: 'not', arg: null },
        { op: 'and', args: [TRUE, null] },
        { op: 'and', args: [TRUE, { op: 'nope' }] },
        // eslint-disable-next-line no-sparse-arrays
        { op: 'and', args: [TRUE, , TRUE] },
      ];
      for (const f of bad) {
        expect(await run(f as ResourceFilter, {}), show(f)).to.equal(undefined);
      }
    });

    it('a node with a throwing getter => UNKNOWN', async () => {
      const node = {
        op: 'cmp',
        get field(): string {
          throw new Error('x');
        },
        cmp: 'null',
      };
      expect(await run(node as unknown as ResourceFilter, {})).to.equal(undefined);
      const proxy = new Proxy(
        {},
        {
          get() {
            throw new Error('x');
          },
        },
      );
      expect(await run(proxy as ResourceFilter, {})).to.equal(undefined);
      expect(await run({ op: 'or', args: [proxy as ResourceFilter, FALSE] }, {})).to.equal(undefined);
    });

    const nest = (depth: number, leaf: ResourceFilter, wrap: (f: ResourceFilter) => ResourceFilter): ResourceFilter => {
      let f = leaf;
      for (let i = 1; i < depth; i++) f = wrap(f);
      return f;
    };

    it('nesting 256 deep evaluates', async () => {
      expect(
        await run(
          nest(256, TRUE, (f) => ({ op: 'and', args: [f] })),
          {},
        ),
      ).to.equal(true);
      expect(
        await run(
          nest(256, TRUE, (f) => ({ op: 'not', arg: f })),
          {},
        ),
      ).to.equal(false);
    });

    it('nesting 257 or 300 deep => UNKNOWN, no stack overflow', async () => {
      expect(
        await run(
          nest(257, TRUE, (f) => ({ op: 'and', args: [f] })),
          {},
        ),
      ).to.equal(undefined);
      expect(
        await run(
          nest(300, TRUE, (f) => ({ op: 'and', args: [f] })),
          {},
        ),
      ).to.equal(undefined);
      expect(
        await run(
          nest(300, FALSE, (f) => ({ op: 'not', arg: f })),
          {},
        ),
      ).to.equal(undefined);
      expect(
        await run(
          nest(300, TRUE, (f) => ({ op: 'or', args: [FALSE, f] })),
          {},
        ),
      ).to.equal(undefined);
      expect(
        await run(
          nest(100000, TRUE, (f) => ({ op: 'not', arg: f })),
          {},
        ),
      ).to.equal(undefined);
    });

    it('a cyclic filter => UNKNOWN', async () => {
      const cyclic: { op: 'and'; args: ResourceFilter[] } = { op: 'and', args: [] };
      cyclic.args.push(cyclic);
      expect(await run(cyclic, {})).to.equal(undefined);
    });

    it('never rejects', async () => {
      const e = env();
      (e as { attribute: unknown }).attribute = 'not a function';
      expect(await run(cmp('x', 'null'), {}, e)).to.equal(undefined);
    });

    it('does not mutate the filter', async () => {
      const f: ResourceFilter = { op: 'and', args: [cmp('x', 'in', [1, 2]), { op: 'not', arg: cmp('y', 'null') }, { op: 'under', scopes: [GLOBAL] }] };
      const copy = structuredClone(f);
      await run(f, { x: 1, y: 2 });
      expect(f).to.deep.equal(copy);
    });
  });

  describe('defaultAttribute', () => {
    it('reads dotted paths over own properties', () => {
      const s = { a: { b: { c: 3 } }, list: ['x', 'y'], n: null, z: 0 };
      expect(defaultAttribute(s, 'a.b.c')).to.equal(3);
      expect(defaultAttribute(s, 'a.b')).to.equal(s.a.b);
      expect(defaultAttribute(s, 'list.1')).to.equal('y');
      expect(defaultAttribute(s, 'z')).to.equal(0);
      expect(defaultAttribute(s, 'n')).to.equal(null);
      expect(defaultAttribute(s, 'missing')).to.equal(undefined);
      expect(defaultAttribute(s, 'a.missing.c')).to.equal(undefined);
    });

    it('non-object on the way => undefined', () => {
      expect(defaultAttribute({ a: 'str' }, 'a.length')).to.equal(undefined);
      expect(defaultAttribute({ a: null }, 'a.b')).to.equal(undefined);
      expect(defaultAttribute({ a: 5 }, 'a.b')).to.equal(undefined);
      expect(defaultAttribute(null, 'a')).to.equal(undefined);
      expect(defaultAttribute(undefined, 'a')).to.equal(undefined);
      expect(defaultAttribute('abc', 'length')).to.equal(undefined);
    });

    it('own properties only: prototype getters and inherited values => undefined', () => {
      class Row {
        own = 1;
        get computed(): number {
          return 2;
        }
      }
      expect(defaultAttribute(new Row(), 'own')).to.equal(1);
      expect(defaultAttribute(new Row(), 'computed')).to.equal(undefined);
      expect(defaultAttribute(Object.create({ inherited: 1 }), 'inherited')).to.equal(undefined);
      expect(defaultAttribute({}, 'toString')).to.equal(undefined);
      expect(defaultAttribute({}, 'hasOwnProperty')).to.equal(undefined);
    });

    it('__proto__, prototype and constructor segments => undefined', () => {
      const s = JSON.parse('{"__proto__": {"x": 1}, "prototype": {"x": 1}, "constructor": {"x": 1}, "a": {"constructor": 5}}');
      expect(defaultAttribute(s, '__proto__')).to.equal(undefined);
      expect(defaultAttribute(s, '__proto__.x')).to.equal(undefined);
      expect(defaultAttribute(s, 'prototype.x')).to.equal(undefined);
      expect(defaultAttribute(s, 'constructor.x')).to.equal(undefined);
      expect(defaultAttribute(s, 'a.constructor')).to.equal(undefined);
      expect(defaultAttribute(function f() {}, 'prototype')).to.equal(undefined);
    });

    it('throwing getter => undefined', () => {
      const s = {
        get x(): number {
          throw new Error('x');
        },
        a: {
          get b(): number {
            throw new Error('x');
          },
        },
      };
      expect(defaultAttribute(s, 'x')).to.equal(undefined);
      expect(defaultAttribute(s, 'a.b')).to.equal(undefined);
      const proxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('x');
          },
        },
      );
      expect(defaultAttribute(proxy, 'a')).to.equal(undefined);
    });
  });

  describe('work budget', () => {
    // Linear in size, exponential as a tree: every level refers to the previous one twice.
    const dag = (depth: number, a: ResourceFilter, b: ResourceFilter): ResourceFilter => {
      let x = a;
      for (let i = 0; i < depth; i++) x = or(and(x, a), and(x, b));
      return x;
    };

    it('a shared-subtree DAG 30 levels deep finishes fast and is UNKNOWN', async () => {
      let reads = 0;
      const e = env({
        attribute: () => {
          reads++;
          return null;
        },
      });
      const started = Date.now();
      expect(await run(dag(30, cmp('x', 'eq', 1), cmp('y', 'eq', 2)), {}, e)).to.equal(undefined);
      expect(Date.now() - started).to.be.below(10000);
      expect(reads).to.be.at.most(2);
    });

    const u1 = cmp('n', 'eq', 1);
    const u2 = cmp('n', 'eq', 2);
    // Both kinds evaluate the previous level twice: the UNKNOWN first arguments never short-circuit.
    const trueDag = (depth: number): ResourceFilter => {
      let x: ResourceFilter = cmp('t', 'eq', 1);
      for (let i = 0; i < depth; i++) x = and(or(u1, x), or(u2, x));
      return x;
    };
    const falseDag = (depth: number): ResourceFilter => {
      let x: ResourceFilter = cmp('t', 'eq', 2);
      for (let i = 0; i < depth; i++) x = or(and(u1, x), and(u2, x));
      return x;
    };

    it('small DAGs evaluate to their value', async () => {
      expect(await run(trueDag(8), { t: 1 })).to.equal(true);
      expect(await run(falseDag(8), { t: 1 })).to.equal(false);
      expect(await run(dag(8, cmp('x', 'eq', 1), cmp('x', 'eq', 2)), { x: 1 })).to.equal(true);
    });

    it('a DAG whose value is decided before the budget runs out keeps that value', async () => {
      const big = dag(30, cmp('x', 'eq', null), cmp('y', 'eq', null));
      expect(await run({ op: 'or', args: [TRUE, big] }, {})).to.equal(true);
      expect(await run({ op: 'and', args: [FALSE, big] }, {})).to.equal(false);
    });

    it('once the budget is spent a large DAG is UNKNOWN, never TRUE, also under not', async () => {
      const started = Date.now();
      expect(await run(trueDag(40), { t: 1 })).to.equal(undefined);
      expect(await run(falseDag(40), { t: 1 })).to.equal(undefined);
      expect(await run({ op: 'not', arg: falseDag(40) }, { t: 1 })).to.equal(undefined);
      expect(Date.now() - started).to.be.below(15000);
    });

    it('matcher work counts against the same budget', async () => {
      const text = 'a'.repeat(10000);
      const heavy = (): ResourceFilter => cmp('x', 'like', '%'.repeat(390) + 'b');
      const started = Date.now();
      const many: ResourceFilter = { op: 'or', args: Array.from({ length: 50 }, heavy) };
      expect(await run(many, { x: text })).to.equal(undefined);
      expect(Date.now() - started).to.be.below(5000);
      // one heavy matcher alone fits, and one node shared 50 times is matched once
      expect(await run(heavy(), { x: text })).to.equal(false);
      const shared = heavy();
      expect(await run({ op: 'or', args: Array.from({ length: 50 }, () => shared) }, { x: text })).to.equal(false);
    });

    it('a spent budget leaves the remaining nodes UNKNOWN, so a later relation is not called', async () => {
      const text = 'a'.repeat(10000);
      const heavy = (): ResourceFilter => cmp('x', 'like', '%'.repeat(390) + 'b');
      const e = env({ relations: { 'doc#owner': { holds: () => true } } });
      const f: ResourceFilter = { op: 'or', args: [...Array.from({ length: 50 }, heavy), { op: 'relation', relation: 'owner' }] };
      expect(await run(f, { x: text }, e)).to.equal(undefined);
      expect(e.calls.relation).to.deep.equal([]);
    });

    it('each evaluation gets its own budget', async () => {
      const e = env();
      await run(trueDag(40), { t: 1 }, e);
      expect(await run(TRUE, {}, e)).to.equal(true);
      expect(await run(trueDag(8), { t: 1 }, e)).to.equal(true);
    });

    // Every level visits the shared heavy leaf twice as often as the one before.
    const heavyDag = (depth: number, leaf: ResourceFilter): ResourceFilter => {
      let x = leaf;
      for (let i = 0; i < depth; i++) x = and(or(u1, x), or(u2, x));
      return x;
    };

    it('a 40-level DAG over a shared 100k-element in leaf finishes fast', async () => {
      const list: (string | number)[] = Array.from({ length: 100000 }, (_, i) => i + 10);
      list.push('x');
      const started = Date.now();
      expect(await run(heavyDag(40, cmp('a', 'in', list)), { a: 7 })).to.equal(undefined);
      expect(await run(heavyDag(40, cmp('a', 'in', list)), { a: null })).to.equal(undefined);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('a 40-level DAG over a shared lt leaf on long strings finishes fast', async () => {
      const long = 'a'.repeat(200000);
      const started = Date.now();
      expect(await run(heavyDag(40, cmp('s', 'lt', long + 'b')), { s: long })).to.equal(undefined);
      expect(await run(heavyDag(8, cmp('s', 'lt', long + 'b')), { s: long })).to.equal(true);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('a 40-level DAG over a shared under leaf finishes fast', async () => {
      const scopes: ResourceRef[] = Array.from({ length: 2000 }, (_, i) => ({ type: 'org', id: `o${i + 10}` }));
      const ancestors: ResourceRef[] = [REF, ...Array.from({ length: 500 }, (_, i) => ({ type: 'folder', id: `f${i}` })), GLOBAL];
      const e = env({ ancestors: () => Promise.resolve(ancestors) });
      const started = Date.now();
      expect(await run(heavyDag(40, { op: 'under', scopes }), {}, e)).to.equal(undefined);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('under looks scopes up in an index of the ancestors instead of comparing every pair', async () => {
      const scopes: ResourceRef[] = Array.from({ length: 5000 }, (_, i) => ({ type: 'org', id: `o${i + 10}` }));
      scopes.push({ type: 'folder', id: 'f4999' });
      const ancestors: ResourceRef[] = [REF, ...Array.from({ length: 5000 }, (_, i) => ({ type: 'folder', id: `f${i}` })), GLOBAL];
      const e = env({ ancestors: () => Promise.resolve(ancestors) });
      const started = Date.now();
      expect(await run({ op: 'under', scopes }, {}, e)).to.equal(true);
      expect(await run({ op: 'under', scopes: scopes.slice(0, 5000) }, {}, e)).to.equal(false);
      expect(await run({ op: 'under', scopes: [...scopes.slice(0, 5000), { type: 'folder' }] }, {}, e)).to.equal(true);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('under keys cannot collide through a NUL in a type or id', async () => {
      const e = env({ ancestors: () => Promise.resolve([{ type: 'a\u0000b', id: 'c' }, GLOBAL]) });
      expect(await run({ op: 'under', scopes: [{ type: 'a', id: 'b\u0000c' }] }, {}, e)).to.equal(false);
      expect(await run({ op: 'under', scopes: [{ type: 'a\u0000b', id: 'c' }] }, {}, e)).to.equal(true);
      expect(await run({ op: 'under', scopes: [{ type: 'a' }] }, {}, e)).to.equal(false);
    });

    it('a shared relation or native leaf is called once per evaluation', async () => {
      let holds = 0;
      let matches = 0;
      const e = env({
        relations: {
          'doc#owner': {
            holds: () => {
              holds++;
              return true;
            },
          },
        },
        natives: {
          'native:n': {
            op: 'native:n',
            matches: () => {
              matches++;
              return true;
            },
          },
        },
      });
      expect(await run(heavyDag(6, { op: 'relation', relation: 'owner' }), {}, e)).to.equal(true);
      expect(await run(heavyDag(6, { op: 'native:n' }), {}, e)).to.equal(true);
      expect([holds, matches]).to.deep.equal([1, 1]);
    });

    it('a long numeric-looking attribute against a long number list is parsed once', async () => {
      const digits = '1'.repeat(20000);
      const list = Array.from({ length: 50000 }, (_, i) => i);
      const started = Date.now();
      expect(await run(cmp('a', 'in', list), { a: digits })).to.equal(undefined);
      expect(Date.now() - started).to.be.below(2500);
    });

    it('a huge pattern against a short text is charged by pattern length', async () => {
      expect(await run(cmp('x', 'like', 'a'.repeat(200000)), { x: '' })).to.equal(undefined);
      expect(await run(cmp('x', 'like', 'a'.repeat(1000)), { x: '' })).to.equal(false);
    });
  });

  describe('inputs are read once', () => {
    it('an in list is copied by index; its own iterator is never used', async () => {
      const list = [5];
      Object.defineProperty(list, Symbol.iterator, {
        value: function* () {
          yield 1;
          yield true;
        },
      });
      expect(await run(cmp('x', 'in', list), { x: 1 })).to.equal(false);
      expect(await run(cmp('x', 'nin', list), { x: 1 })).to.equal(true);
    });

    it('a list element behind a getter is read once', async () => {
      let n = 0;
      const list = [5];
      Object.defineProperty(list, 0, { get: () => (n++ === 0 ? 5 : 1), enumerable: true });
      expect(await run(cmp('x', 'in', list), { x: 1 })).to.equal(false);
      expect(n).to.equal(1);
    });

    it('under scopes are copied by index; their iterator is never used', async () => {
      const scopes: ResourceRef[] = [{ type: 'org', id: 'o2' }];
      Object.defineProperty(scopes, Symbol.iterator, {
        value: function* () {
          yield { type: 'org' };
        },
      });
      const e = env({ ancestors: () => Promise.resolve([REF, { type: 'org', id: 'o1' }, GLOBAL]) });
      expect(await run({ op: 'under', scopes }, {}, e)).to.equal(false);
    });

    it('scope entry fields are read once', async () => {
      let reads = 0;
      const scope = {
        get type(): string {
          reads++;
          return reads === 1 ? 'org' : 'doc';
        },
        id: 'o1',
      };
      const e = env({ ancestors: () => Promise.resolve([REF, { type: 'org', id: 'o1' }, GLOBAL]) });
      expect(await run({ op: 'under', scopes: [scope] }, {}, e)).to.equal(true);
      expect(reads).to.equal(1);
    });

    it('the ancestor list is copied by index; its iterator is never used', async () => {
      const list = [REF];
      Object.defineProperty(list, Symbol.iterator, {
        value: function* () {
          yield GLOBAL;
        },
      });
      const e = env({ ancestors: () => Promise.resolve(list) });
      expect(await run({ op: 'under', scopes: [GLOBAL] }, {}, e)).to.equal(false);
    });

    it('a subject field is read once per evaluation, even when two comparisons use it', async () => {
      let n = 0;
      const subject = {
        get x(): number | null {
          return n++ === 0 ? null : 5;
        },
      };
      expect(await run({ op: 'and', args: [cmp('x', 'null'), cmp('x', 'eq', 5)] }, subject)).to.equal(undefined);
      expect(n).to.equal(1);
    });

    it('calls the attribute reader once per field', async () => {
      const seen: string[] = [];
      const e = env({
        attribute: (_s, f) => {
          seen.push(f);
          return 1;
        },
      });
      await run({ op: 'and', args: [cmp('x', 'eq', 1), cmp('x', 'ne', 2), cmp('y', 'notnull'), cmp('x', 'in', [1])] }, {}, e);
      expect(seen).to.deep.equal(['x', 'y']);
    });
  });

  describe('subject values are never called', () => {
    it('a thenable attribute value is incomparable and its then is not called', async () => {
      let called = 0;
      const owner = {
        then(): void {
          called++;
        },
      };
      expect(await run(cmp('owner', 'notnull'), { owner })).to.equal(true);
      expect(await run(cmp('owner', 'null'), { owner })).to.equal(false);
      expect(await run(cmp('owner', 'eq', 1), { owner })).to.equal(undefined);
      expect(called).to.equal(0);
    });

    it('a Promise subclass is a value: incomparable, its then not called', async () => {
      let called = 0;
      class Lazy extends Promise<unknown> {}
      Object.defineProperty(Lazy.prototype, 'then', {
        value() {
          called++;
        },
      });
      const lazy = new Lazy(() => undefined);
      expect(await run(cmp('x', 'eq', 1), { x: lazy })).to.equal(undefined);
      expect(await run(cmp('x', 'notnull'), { x: lazy })).to.equal(true);
      expect(called).to.equal(0);
    });

    it('a native promise from the reader is UNKNOWN; an own then on it is not called', async () => {
      let called = 0;
      const p = Promise.reject(new Error('late'));
      Object.defineProperty(p, 'then', {
        value() {
          called++;
        },
      });
      const e = env({ attribute: () => p });
      expect(await run(cmp('x', 'notnull'), {}, e)).to.equal(undefined);
      expect(called).to.equal(0);
      await new Promise((r) => setImmediate(r));
    });
  });

  describe('Dates outside years 0000-9999', () => {
    const rows: readonly [Date, Truth][] = [
      [new Date('+010000-01-01T00:00:00.000Z'), undefined],
      [new Date('-000001-01-01T00:00:00.000Z'), undefined],
      [new Date('9999-12-31T23:59:59.999Z'), true],
      [new Date('0000-01-01T00:00:00.000Z'), true],
    ];
    for (const [d, lt] of rows) {
      it(`${show(d)}: lt / eq follow the ISO string only inside the range`, async () => {
        const iso = d.toISOString();
        expect(await run(cmp('x', 'lt', '99999'), { x: d })).to.equal(lt);
        expect(await run(cmp('x', 'eq', iso), { x: d })).to.equal(lt);
        expect(await run(cmp('x', 'notnull'), { x: d })).to.equal(true);
      });
    }
  });

  describe('properties', () => {
    const FIELDS = ['a', 'b', 'c'] as const;
    const POOL: readonly Value[] = [null, 0, 1, 2, '1', 'x', true, false];
    const LISTS: readonly Value[] = [[], [1], [1, 'x'], ['1', 2], [0], null, 1];
    const ATTRS: readonly unknown[] = [null, undefined, 0, 1, 2, '1', 'x', true, false, { o: 1 }];

    const atomArb: fc.Arbitrary<ResourceFilter> = fc.oneof(fc.record({ op: fc.constant('cmp' as const), field: fc.constantFrom(...FIELDS), cmp: fc.constantFrom<CmpOp>('eq', 'ne', 'lt'), value: fc.constantFrom(...POOL) }), fc.record({ op: fc.constant('cmp' as const), field: fc.constantFrom(...FIELDS), cmp: fc.constantFrom<CmpOp>('in', 'nin'), value: fc.constantFrom(...LISTS) }), fc.record({ op: fc.constant('cmp' as const), field: fc.constantFrom(...FIELDS), cmp: fc.constantFrom<CmpOp>('null', 'notnull') }), fc.constant(TRUE), fc.constant(FALSE)) as fc.Arbitrary<ResourceFilter>;

    const treeArb: fc.Arbitrary<ResourceFilter> = fc.letrec<{ tree: ResourceFilter }>((tie) => ({
      tree: fc.oneof({ depthSize: 'small', withCrossShrink: true }, atomArb, fc.record({ op: fc.constantFrom('and' as const, 'or' as const), args: fc.array(tie('tree'), { minLength: 0, maxLength: 4 }) }) as fc.Arbitrary<ResourceFilter>, fc.record({ op: fc.constant('not' as const), arg: tie('tree') }) as fc.Arbitrary<ResourceFilter>),
    })).tree;

    // a missing field is a key left out of the row
    const rowArb = fc.dictionary(fc.constantFrom(...FIELDS), fc.constantFrom(...ATTRS), { maxKeys: 3 });

    it('evaluateResidual(simplify(f)) equals evaluateResidual(f)', async () => {
      await fc.assert(
        fc.asyncProperty(treeArb, rowArb, async (f, row) => {
          expect(await run(simplify(f), row)).to.equal(await run(f, row));
        }),
        { numRuns: 500 },
      );
    });

    it('not f is TRUE iff f is FALSE, UNKNOWN stays UNKNOWN', async () => {
      await fc.assert(
        fc.asyncProperty(treeArb, rowArb, async (f, row) => {
          const v = await run(f, row);
          const n = await run({ op: 'not', arg: f }, row);
          expect(n).to.equal(v === undefined ? undefined : !v);
        }),
        { numRuns: 500 },
      );
    });

    // Slow references: plain recursion over the pattern, written independently.
    const refWildcard = (p: string, t: string): boolean => {
      if (p === '') return t === '';
      if (p[0] === '*') return refWildcard(p.slice(1), t) || (t !== '' && refWildcard(p, t.slice(1)));
      return t !== '' && t[0] === p[0] && refWildcard(p.slice(1), t.slice(1));
    };
    const refGlob = (p: string, t: string): boolean => {
      if (p === '') return t === '';
      if (p.startsWith('**')) return refGlob(p.slice(2), t) || (t !== '' && refGlob(p, t.slice(1)));
      if (p[0] === '*') return refGlob(p.slice(1), t) || (t !== '' && t[0] !== '/' && refGlob(p, t.slice(1)));
      return t !== '' && t[0] === p[0] && refGlob(p.slice(1), t.slice(1));
    };
    const refLike = (p: string, t: string): boolean | undefined => {
      for (let i = 0; i < p.length; i += p[i] === '\\' ? 2 : 1) if (p[i] === '\\' && i + 1 === p.length) return undefined;
      const go = (p: string, t: string): boolean => {
        if (p === '') return t === '';
        if (p[0] === '%') return go(p.slice(1), t) || (t !== '' && go(p, t.slice(1)));
        if (p[0] === '_') return t !== '' && go(p.slice(1), t.slice(1));
        if (p[0] === '\\') return t !== '' && t[0] === p[1] && go(p.slice(2), t.slice(1));
        return t !== '' && t[0] === p[0] && go(p.slice(1), t.slice(1));
      };
      return go(p, t);
    };

    const ALPHABET = ['a', 'b', '/', '%', '_', '\\', '*'];
    const strArb = (max: number) => fc.array(fc.constantFrom(...ALPHABET), { maxLength: max }).map((xs) => xs.join(''));

    it('matchWildcard agrees with a slow reference', () => {
      fc.assert(
        fc.property(strArb(7), strArb(8), (p, t) => {
          expect(matchWildcard(p, t)).to.equal(refWildcard(p, t));
        }),
        { numRuns: 1000 },
      );
    });

    it('matchGlob agrees with a slow reference', () => {
      fc.assert(
        fc.property(strArb(7), strArb(8), (p, t) => {
          expect(matchGlob(p, t)).to.equal(refGlob(p, t));
        }),
        { numRuns: 1000 },
      );
    });

    it('matchLike agrees with a slow reference', () => {
      fc.assert(
        fc.property(strArb(7), strArb(8), (p, t) => {
          expect(matchLike(p, t)).to.equal(refLike(p, t));
        }),
        { numRuns: 1000 },
      );
    });
  });
});

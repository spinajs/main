import { and, not, or } from '@spinajs/authz';
import type { ResourceFilter } from '@spinajs/authz';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { sameFilter } from '../../src/model/same-filter.js';

const expect = chai.expect;

const native = (args: unknown): ResourceFilter => ({ op: 'native:test.x', args });
const cmp = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value } as ResourceFilter);

describe('authz-rbac model: sameFilter (RFC C3-1)', () => {
  it('equal trees are the same, operands in order', () => {
    expect(sameFilter(and(cmp('a', 1), { op: 'relation', relation: 'self' }), and(cmp('a', 1), { op: 'relation', relation: 'self' }))).to.equal(true);
    expect(sameFilter(not(cmp('a', 'x')), not(cmp('a', 'x')))).to.equal(true);
    expect(sameFilter({ op: 'under', scopes: [{ type: 'org', id: 'o1' }] }, { op: 'under', scopes: [{ type: 'org', id: 'o1' }] })).to.equal(true);
    expect(sameFilter({ op: 'true' }, { op: 'true' })).to.equal(true);
  });

  it('reordered operands are not the same (a missed match only splits a group)', () => {
    expect(sameFilter(or(cmp('a', 1), cmp('b', 1)), or(cmp('b', 1), cmp('a', 1)))).to.equal(false);
  });

  it('a different op, field, relation or value is not the same', () => {
    expect(sameFilter(and(cmp('a', 1), cmp('b', 1)), or(cmp('a', 1), cmp('b', 1)))).to.equal(false);
    expect(sameFilter(cmp('a', 1), cmp('b', 1))).to.equal(false);
    expect(sameFilter(cmp('a', 1), cmp('a', '1'))).to.equal(false);
    expect(sameFilter(cmp('a', 0), cmp('a', -0))).to.equal(false);
    expect(sameFilter({ op: 'relation', relation: 'self' }, { op: 'relation', relation: 'member' })).to.equal(false);
    expect(sameFilter(native(1), { op: 'native:test.y', args: 1 })).to.equal(false);
  });

  it('native args: primitives by Object.is, Dates by time, plain data by own enumerable keys', () => {
    expect(sameFilter(native(Number.NaN), native(Number.NaN))).to.equal(true);
    expect(sameFilter(native(1n), native(1n))).to.equal(true);
    expect(sameFilter(native(1n), native(2n))).to.equal(false);
    expect(sameFilter(native(new Date(5)), native(new Date(5)))).to.equal(true);
    expect(sameFilter(native(new Date(5)), native(new Date(6)))).to.equal(false);
    expect(sameFilter(native({ a: [1, { b: null }] }), native({ a: [1, { b: null }] }))).to.equal(true);
    expect(sameFilter(native(Object.assign(Object.create(null), { a: 1 })), native(Object.assign(Object.create(null), { a: 1 })))).to.equal(true);
    expect(sameFilter(native({ x: undefined }), native({}))).to.equal(false);
    expect(sameFilter(native(undefined), native(null))).to.equal(false);
    expect(sameFilter({ op: 'native:test.x' }, native(undefined))).to.equal(false);
    expect(sameFilter(native([1, 2]), native({ 0: 1, 1: 2 }))).to.equal(false);
    expect(sameFilter(native(new Array<unknown>(1)), native([undefined]))).to.equal(false);
    expect(sameFilter(native(Object.create(null)), native({}))).to.equal(false);
  });

  it('values with no canonical form are the same only as the same reference', () => {
    const fn = () => 1;
    expect(sameFilter(native(fn), native(fn))).to.equal(true);
    expect(
      sameFilter(
        native(() => 1),
        native(() => 1),
      ),
    ).to.equal(false);
    expect(sameFilter(native(new Map([['a', 1]])), native(new Map([['b', 1]])))).to.equal(false);
    expect(sameFilter(native(new Map([['a', 1]])), native(new Map([['a', 1]])))).to.equal(false);
    expect(sameFilter(native(new Set([1])), native(new Set([1])))).to.equal(false);
    class Box {
      constructor(readonly v: number) {}
    }
    expect(sameFilter(native(new Box(1)), native(new Box(1)))).to.equal(false);
    const box = new Box(1);
    expect(sameFilter(native(box), native(box))).to.equal(true);
    expect(sameFilter(native({ [Symbol('s')]: 1 }), native({ [Symbol('s')]: 1 }))).to.equal(false);
    const hidden = (v: number) => Object.defineProperty({}, 'v', { value: v, enumerable: false });
    expect(sameFilter(native(hidden(1)), native(hidden(1)))).to.equal(false);
    const getter = () => ({
      get v() {
        return 1;
      },
    });
    expect(sameFilter(native(getter()), native(getter()))).to.equal(false);
    const dated = Object.assign(new Date(0), { extra: 1 });
    expect(sameFilter(native(dated), native(Object.assign(new Date(0), { extra: 1 })))).to.equal(false);
  });

  it('over the work budget, deep or cyclic, it answers false', () => {
    const deep = (n: number): unknown => (n === 0 ? 1 : { d: deep(n - 1) });
    expect(sameFilter(native(deep(30)), native(deep(30)))).to.equal(true);
    expect(sameFilter(native(deep(200)), native(deep(200)))).to.equal(false);
    const wide = () => Array.from({ length: 20_000 }, (_, i) => ({ i }));
    expect(sameFilter(native(wide()), native(wide()))).to.equal(false);
    const cycle = (): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    };
    expect(sameFilter(native(cycle()), native(cycle()))).to.equal(false);
  });

  it('a long array of primitives is over the work budget', () => {
    expect(sameFilter(native(Array.from({ length: 5_000 }, (_, i) => i)), native(Array.from({ length: 5_000 }, (_, i) => i)))).to.equal(true);
    expect(sameFilter(native(Array.from({ length: 20_000 }, (_, i) => i)), native(Array.from({ length: 20_000 }, (_, i) => i)))).to.equal(false);
    const huge = () => new Array<number>(2_000_000).fill(0);
    expect(sameFilter(native(huge()), native(huge()))).to.equal(false);
    const wide = () => Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]));
    expect(sameFilter(native(wide()), native(wide()))).to.equal(false);
  });

  it('an array with a reset prototype is never the same as a non-array', () => {
    expect(sameFilter(native(Object.setPrototypeOf([1], null)), native(Object.assign(Object.create(null), { 0: 1 })))).to.equal(false);
    expect(sameFilter(native(Object.setPrototypeOf([1], Object.prototype)), native({ 0: 1 }))).to.equal(false);
    expect(sameFilter(native(Object.setPrototypeOf([1], Object.prototype)), native(Object.setPrototypeOf([1], Object.prototype)))).to.equal(false);
  });

  it('proxies are the same only as the same reference', () => {
    const trap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(sameFilter(native(trap), native({}))).to.equal(false);
    const lying = (v: number) => new Proxy({ v: 1 }, { get: () => v });
    expect(sameFilter(native(lying(1)), native(lying(2)))).to.equal(false);
    expect(sameFilter(native(new Proxy({ v: 1 }, {})), native({ v: 1 }))).to.equal(false);
    const p = lying(1);
    expect(sameFilter(native(p), native(p))).to.equal(true);
  });

  it('objects with internal slots and a reset prototype are not the same', () => {
    const plain = <T extends object>(o: T): T => Object.setPrototypeOf(o, Object.prototype) as T;
    expect(sameFilter(native(plain(new Map([['a', 1]]))), native(plain(new Map([['b', 2]]))))).to.equal(false);
    expect(sameFilter(native(plain(new Set([1]))), native(plain(new Set([2]))))).to.equal(false);
    expect(sameFilter(native(plain(new Date(1))), native(plain(new Date(2))))).to.equal(false);
    expect(sameFilter(native(plain(new Date(1))), native({}))).to.equal(false);
    expect(sameFilter(native(plain(Object(1) as object)), native(plain(Object(2) as object)))).to.equal(false);
    expect(sameFilter(native(plain(new Uint8Array([1]))), native({ 0: 1 }))).to.equal(false);
    expect(sameFilter(native(plain(new ArrayBuffer(1))), native(plain(new ArrayBuffer(1))))).to.equal(false);
    expect(sameFilter(native(plain(/a/)), native(plain(/b/)))).to.equal(false);
    expect(sameFilter(native(plain(Promise.resolve(1))), native(plain(Promise.resolve(2))))).to.equal(false);
    expect(sameFilter(native(plain(new WeakMap())), native(plain(new WeakMap())))).to.equal(false);
  });

  describe('properties', () => {
    const leaf: fc.Arbitrary<ResourceFilter> = fc.oneof(fc.record({ op: fc.constant('cmp' as const), field: fc.constantFrom('a', 'b'), cmp: fc.constantFrom('eq' as const, 'ne' as const), value: fc.oneof(fc.integer({ min: 0, max: 2 }), fc.constantFrom('x', 'y'), fc.constant(null)) }), fc.record({ op: fc.constant('relation' as const), relation: fc.constantFrom('self', 'member') }), fc.record({ op: fc.constant('under' as const), scopes: fc.array(fc.record({ type: fc.constant('org'), id: fc.constantFrom('o1', 'o2') }), { minLength: 1, maxLength: 2 }) }), fc.record({ op: fc.constant('native:test.x' as const), args: fc.jsonValue({ maxDepth: 2 }) }));
    // fc.record builds null-prototype objects, which sameFilter keeps apart from the clone's plain ones.
    const { filter: tree } = fc.letrec<{ filter: ResourceFilter }>((tie) => ({
      filter: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leaf, fc.record({ op: fc.constantFrom('and' as const, 'or' as const), args: fc.array(tie('filter'), { minLength: 1, maxLength: 3 }) }), fc.record({ op: fc.constant('not' as const), arg: tie('filter') })) as fc.Arbitrary<ResourceFilter>,
    }));
    const filter = tree.map((f) => JSON.parse(JSON.stringify(f)) as ResourceFilter);

    it('a structured clone of plain data is the same', () => {
      fc.assert(
        fc.property(filter, (f) => {
          expect(sameFilter(f, structuredClone(f))).to.equal(true);
        }),
        { numRuns: 500 },
      );
    });

    // Every primitive in the tree: an op, a field name, a value or a native arg.
    it('a clone with exactly one primitive changed is not the same', () => {
      fc.assert(
        fc.property(filter, fc.nat(), fc.constantFrom('swap', 'array', 'object'), (f, pick, how) => {
          const g = structuredClone(f);
          const sites = primitiveSites(g);
          const [parent, key] = sites[pick % sites.length];
          const old = parent[key];
          parent[key] = how === 'swap' ? otherPrimitive(old) : how === 'array' ? [old] : { 0: old };
          expect(JSON.stringify(g)).to.not.equal(JSON.stringify(f));
          expect(sameFilter(f, g)).to.equal(false);
          expect(sameFilter(g, f)).to.equal(false);
        }),
        { numRuns: 1000 },
      );
    });
  });
});

type Slot = [Record<string | number, unknown>, string | number];

function primitiveSites(node: unknown, out: Slot[] = []): Slot[] {
  if (typeof node !== 'object' || node === null) return out;
  const parent = node as Record<string | number, unknown>;
  for (const key of Array.isArray(node) ? node.keys() : Object.keys(node)) {
    const v = parent[key];
    if (typeof v === 'object' && v !== null) primitiveSites(v, out);
    else out.push([parent, key]);
  }
  return out;
}

function otherPrimitive(v: unknown): unknown {
  if (typeof v === 'number') return v === 0 ? 1 : -v;
  if (typeof v === 'string') return `${v}z`;
  if (typeof v === 'boolean') return !v;
  return 0;
}

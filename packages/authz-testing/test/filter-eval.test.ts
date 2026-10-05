import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { Authorizer, FALSE, GLOBAL, NativeFilter, TRUE, and, bindRefs, not, or, simplify } from '@spinajs/authz';
import type { EvaluationContext, ResourceFilter, ResourceRef, Value } from '@spinajs/authz';

import { FakePermissionRegistry, FakeRelationResolver, StaticModel, evaluateFilter, fakeEvaluationContext, fixtureDsl, isAllowed, userPrincipal, withAttributes } from '../src/index.js';
import type { FilterEnv, Kleene } from '../src/index.js';

const alice = userPrincipal('alice', { attributes: { pool: 'p1', level: 3, tags: ['a', 'b'], nested: { x: 1 } } });
const ref: ResourceRef = { type: 'doc', id: 'r1' };
const row = {
  id: 'r1',
  name: 'release/v1',
  path: 'docs/a/b.md',
  size: 10,
  owner: 'alice',
  pool: 'p1',
  deleted: null as null,
  flag: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  meta: { org: 'o1' },
  list: [1, 2],
};

const cmp = (field: string, c: string, value?: Value): ResourceFilter => ({ op: 'cmp', field, cmp: c, ...(value === undefined ? {} : { value }) }) as ResourceFilter;
const ev = (f: ResourceFilter, subject: unknown = row, extra: Partial<FilterEnv> = {}): Promise<Kleene> => evaluateFilter(f, subject, { principal: alice, ref, ...extra });

const T = TRUE;
const F = FALSE;
const U = cmp('missing', 'eq', 'x');
const raw = (op: 'and' | 'or', ...args: ResourceFilter[]): ResourceFilter => ({ op, args });

const sparse: string[] = [];
sparse[0] = 'alice';
sparse[2] = 'x';
// Each holds 'alice', so only the list check keeps them from matching row.owner.
const badLists: readonly unknown[][] = [['alice', null], ['alice', NaN], ['alice', Infinity], ['alice', true], ['alice', { ref: 'principal.id' }], ['alice', ['x']], sparse];

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('evaluateFilter (reference residual evaluator)', () => {
  describe('Kleene logic', () => {
    const val = { T: true, F: false, U: null } as const;
    const node = { T, F, U };
    const kAnd = (a: Kleene, b: Kleene): Kleene => (a === false || b === false ? false : a === null || b === null ? null : true);
    const kOr = (a: Kleene, b: Kleene): Kleene => (a === true || b === true ? true : a === null || b === null ? null : false);

    for (const a of ['T', 'F', 'U'] as const) {
      for (const b of ['T', 'F', 'U'] as const) {
        it(`and(${a}, ${b}) and or(${a}, ${b})`, async () => {
          expect(await ev(raw('and', node[a], node[b]))).to.eq(kAnd(val[a], val[b]));
          expect(await ev(raw('or', node[a], node[b]))).to.eq(kOr(val[a], val[b]));
        });
      }
    }

    it('not: T→F, F→T, U→U', async () => {
      expect(await ev({ op: 'not', arg: T })).to.eq(false);
      expect(await ev({ op: 'not', arg: F })).to.eq(true);
      expect(await ev({ op: 'not', arg: U })).to.eq(null);
    });

    it('empty and is TRUE, empty or is FALSE', async () => {
      expect(await ev(raw('and'))).to.eq(true);
      expect(await ev(raw('or'))).to.eq(false);
    });

    it('isAllowed accepts only TRUE', () => {
      expect(isAllowed(true)).to.eq(true);
      expect(isAllowed(false)).to.eq(false);
      expect(isAllowed(null)).to.eq(false);
    });
  });

  describe('cmp', () => {
    it('eq / ne on matching types', async () => {
      expect(await ev(cmp('owner', 'eq', 'alice'))).to.eq(true);
      expect(await ev(cmp('owner', 'eq', 'bob'))).to.eq(false);
      expect(await ev(cmp('owner', 'ne', 'bob'))).to.eq(true);
      expect(await ev(cmp('size', 'eq', 10))).to.eq(true);
      expect(await ev(cmp('flag', 'eq', true))).to.eq(true);
      expect(await ev(cmp('meta.org', 'eq', 'o1'))).to.eq(true);
    });

    it('a NULL or missing field makes eq/ne/in/nin and the order ops UNKNOWN', async () => {
      for (const c of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard']) {
        expect(await ev(cmp('deleted', c, 'x')), c).to.eq(null);
        expect(await ev(cmp('missing', c, 'x')), c).to.eq(null);
      }
      expect(await ev(cmp('deleted', 'in', ['x']))).to.eq(null);
      expect(await ev(cmp('deleted', 'nin', ['x']))).to.eq(null);
    });

    it('literal null never matches: eq/ne/in/nin with value null are UNKNOWN, also under not', async () => {
      for (const c of ['eq', 'ne', 'in', 'nin']) {
        expect(await ev(cmp('deleted', c, null)), c).to.eq(null);
        expect(await ev(cmp('owner', c, null)), c).to.eq(null);
        expect(await ev({ op: 'not', arg: cmp('owner', c, null) }), `not ${c}`).to.eq(null);
      }
    });

    it('null / notnull are two-valued', async () => {
      expect(await ev(cmp('deleted', 'null'))).to.eq(true);
      expect(await ev(cmp('missing', 'null'))).to.eq(true);
      expect(await ev(cmp('owner', 'null'))).to.eq(false);
      expect(await ev(cmp('deleted', 'notnull'))).to.eq(false);
      expect(await ev(cmp('owner', 'notnull'))).to.eq(true);
      expect(await ev(cmp('missing', 'null'), undefined)).to.eq(true);
    });

    it('a type mismatch is UNKNOWN, so negation cannot turn it into access', async () => {
      expect(await ev(cmp('size', 'eq', '010'))).to.eq(null);
      expect(await ev(cmp('size', 'ne', '010'))).to.eq(null);
      expect(await ev({ op: 'not', arg: cmp('size', 'eq', '010') })).to.eq(null);
      expect(await ev(cmp('owner', 'lt', 5))).to.eq(null);
      expect(await ev(cmp('flag', 'eq', 2))).to.eq(null);
      expect(await ev(cmp('flag', 'eq', 'true'))).to.eq(null);
      expect(await ev(cmp('meta', 'eq', 'x'))).to.eq(null);
      expect(await ev(cmp('list', 'eq', 1))).to.eq(null);
      expect(await ev(cmp('owner', 'eq', ['alice']))).to.eq(null);
      expect(await ev(cmp('owner', 'in', 'alice'))).to.eq(null);
    });

    it('in / nin', async () => {
      expect(await ev(cmp('owner', 'in', ['bob', 'alice']))).to.eq(true);
      expect(await ev(cmp('owner', 'in', ['bob']))).to.eq(false);
      expect(await ev(cmp('owner', 'nin', ['bob']))).to.eq(true);
      expect(await ev(cmp('owner', 'nin', ['alice']))).to.eq(false);
      expect(await ev(cmp('size', 'in', [1, 10]))).to.eq(true);
    });

    it('in [] is FALSE and nin [] is TRUE even on a NULL field (as simplify folds them)', async () => {
      expect(await ev(cmp('deleted', 'in', []))).to.eq(false);
      expect(await ev(cmp('deleted', 'nin', []))).to.eq(true);
    });

    it('in / nin with a mismatched or null element and no match are UNKNOWN (SQL x IN (.., NULL))', async () => {
      expect(await ev(cmp('owner', 'in', ['bob', 5]))).to.eq(null);
      expect(await ev(cmp('owner', 'nin', ['bob', 5]))).to.eq(null);
      expect(await ev(cmp('owner', 'in', ['alice', 5]))).to.eq(true);
      expect(await ev(cmp('owner', 'nin', ['alice', 5]))).to.eq(false);
      expect(await ev(cmp('owner', 'in', ['bob', null] as unknown as Value))).to.eq(null);
    });

    it('a literal list holding anything but strings and finite numbers, or with holes, is missing: UNKNOWN in every polarity', async () => {
      for (const list of badLists) {
        for (const c of ['in', 'nin']) {
          const f = cmp('owner', c, list as Value);
          expect(await ev(f), `${c} ${String(list)}`).to.eq(null);
          expect(await ev({ op: 'not', arg: f }), `not ${c} ${String(list)}`).to.eq(null);
        }
      }
      expect(await ev(cmp('flag', 'in', [true] as unknown as Value))).to.eq(null);
      expect(await ev({ op: 'not', arg: cmp('owner', 'nin', ['alice', null] as unknown as Value) })).to.eq(null);
      expect(await ev(cmp('owner', 'in', ['alice', 5]))).to.eq(true);
    });

    it('order ops on numbers and strings (code point order)', async () => {
      expect(await ev(cmp('size', 'lt', 11))).to.eq(true);
      expect(await ev(cmp('size', 'lte', 10))).to.eq(true);
      expect(await ev(cmp('size', 'gt', 10))).to.eq(false);
      expect(await ev(cmp('size', 'gte', 10))).to.eq(true);
      expect(await ev(cmp('owner', 'gt', 'alex'))).to.eq(true);
      expect(await ev(cmp('s', 'lt', 'a'), { s: 'Z' })).to.eq(true);
      // U+FFFF sorts below U+1F600 by code point, above it by UTF-16 unit
      expect(await ev(cmp('s', 'lt', '\u{1F600}'), { s: '￿' })).to.eq(true);
      expect(await ev(cmp('n', 'lt', 1), { n: Number.NaN })).to.eq(null);
    });

    it('a Date field compares as its ISO string, like a bound env.now', async () => {
      expect(await ev(cmp('createdAt', 'lt', '2026-06-01T00:00:00.000Z'))).to.eq(true);
      expect(await ev(cmp('createdAt', 'lt', { ref: 'env.now' }), row, { env: { now: new Date('2025-01-01T00:00:00.000Z') } })).to.eq(false);
    });

    it('like: % any run, _ one character, case-sensitive, backslash escapes', async () => {
      expect(await ev(cmp('name', 'like', 'release/%'))).to.eq(true);
      expect(await ev(cmp('name', 'like', 'release/v_'))).to.eq(true);
      expect(await ev(cmp('name', 'like', 'release/_'))).to.eq(false);
      expect(await ev(cmp('name', 'like', 'Release/%'))).to.eq(false);
      expect(await ev(cmp('s', 'like', '100\\%'), { s: '100%' })).to.eq(true);
      expect(await ev(cmp('s', 'like', '100\\%'), { s: '1000' })).to.eq(false);
      expect(await ev(cmp('size', 'like', '1%'))).to.eq(null);
    });

    it('like: a pattern ending in a lone backslash is UNKNOWN, as the engine reads it (RFC L4-2)', async () => {
      expect(await ev(cmp('s', 'like', 'a\\'), { s: 'a\\' })).to.eq(null);
      expect(await ev(cmp('s', 'like', 'a\\'), { s: 'a' })).to.eq(null);
      expect(await ev(cmp('s', 'like', '\\'), { s: '\\' })).to.eq(null);
      expect(await ev({ op: 'not', arg: cmp('s', 'like', 'a\\') }, { s: 'a\\' })).to.eq(null);
      expect(await ev({ op: 'not', arg: cmp('s', 'like', 'a\\') }, { s: 'b' })).to.eq(null);
      expect(await ev(cmp('s', 'like', 'a\\\\'), { s: 'a\\' })).to.eq(true);
      expect(await ev(cmp('s', 'like', 'a\\\\\\'), { s: 'a\\' })).to.eq(null);
      expect(await ev(cmp('s', 'like', '😀\\'), { s: '😀\\' })).to.eq(null);
    });

    it('glob: * stops at /, ** crosses it', async () => {
      expect(await ev(cmp('path', 'glob', 'docs/*'))).to.eq(false);
      expect(await ev(cmp('path', 'glob', 'docs/**'))).to.eq(true);
      expect(await ev(cmp('path', 'glob', 'docs/*/b.md'))).to.eq(true);
      expect(await ev(cmp('path', 'glob', '*.md'))).to.eq(false);
      expect(await ev(cmp('path', 'glob', '**.md'))).to.eq(true);
      expect(await ev(cmp('path', 'glob', 'docs/a/b.md'))).to.eq(true);
      expect(await ev(cmp('path', 'glob', 'docs/a/?.md'))).to.eq(false);
    });

    it('wildcard: * crosses /', async () => {
      expect(await ev(cmp('name', 'wildcard', 'release/*'))).to.eq(true);
      expect(await ev(cmp('path', 'wildcard', 'docs/*'))).to.eq(true);
      expect(await ev(cmp('path', 'wildcard', 'docs/*.txt'))).to.eq(false);
      expect(await ev(cmp('path', 'wildcard', 'Docs/*'))).to.eq(false);
    });

    it('patterns are matched without backtracking blow-up', async () => {
      const s = 'a'.repeat(5000);
      const t0 = Date.now();
      expect(await ev(cmp('s', 'wildcard', `${'a*'.repeat(50)}b`), { s })).to.eq(false);
      expect(await ev(cmp('s', 'like', `${'a%'.repeat(50)}b`), { s })).to.eq(false);
      expect(Date.now() - t0).to.be.lessThan(2000);
    });

    it('an unknown cmp throws', async () => {
      let err: unknown;
      try {
        await ev(cmp('owner', 'regex', 'a'));
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(TypeError);
    });
  });

  describe('coercion, as the engine evaluates a residual (L3, L4 hand-off)', () => {
    it('a canonical number string compares with a number as that number, either side', async () => {
      expect(await ev(cmp('size', 'eq', '10'))).to.eq(true);
      expect(await ev(cmp('size', 'ne', '10'))).to.eq(false);
      expect(await ev({ op: 'not', arg: cmp('size', 'eq', '10') })).to.eq(false);
      expect(await ev(cmp('size', 'gt', '9'))).to.eq(true);
      expect(await ev(cmp('s', 'lt', 9), { s: '10' })).to.eq(false);
      expect(await ev(cmp('s', 'eq', 10), { s: '10' })).to.eq(true);
      expect(await ev(cmp('s', 'eq', -2.5), { s: '-2.5' })).to.eq(true);
      expect(await ev(cmp('s', 'eq', 1e21), { s: '1e+21' })).to.eq(true);
      expect(await ev(cmp('size', 'lt', { ref: 'env.limit' }), row, { env: { limit: '20' } })).to.eq(true);
    });

    it('a number string that is not canonical does not compare with a number', async () => {
      for (const s of ['010', '10.0', '1e1', ' 10', '10 ', '', '-0', '1e21', 'NaN', 'Infinity', '0x0a']) {
        for (const c of ['eq', 'ne', 'lt', 'gte']) {
          expect(await ev(cmp('s', c, 10), { s }), `${JSON.stringify(s)} ${c} 10`).to.eq(null);
          expect(await ev(cmp('n', c, s), { n: 10 }), `10 ${c} ${JSON.stringify(s)}`).to.eq(null);
        }
      }
      expect(await ev(cmp('s', 'eq', 0), { s: '0' })).to.eq(true);
      expect(await ev(cmp('n', 'eq', '0'), { n: -0 })).to.eq(true);
    });

    it('in / nin coerce each element the same way', async () => {
      expect(await ev(cmp('size', 'in', ['9', '10']))).to.eq(true);
      expect(await ev(cmp('s', 'in', [9, 10]), { s: '10' })).to.eq(true);
      expect(await ev(cmp('size', 'nin', ['9', '11']))).to.eq(true);
      expect(await ev(cmp('size', 'nin', ['10']))).to.eq(false);
      expect(await ev(cmp('size', 'in', ['010']))).to.eq(null);
      expect(await ev(cmp('size', 'nin', ['010']))).to.eq(null);
      expect(await ev(cmp('size', 'in', ['010', '10']))).to.eq(true);
    });

    it('a boolean equals 0 and 1 only: eq, ne, in, nin', async () => {
      expect(await ev(cmp('flag', 'eq', 1))).to.eq(true);
      expect(await ev(cmp('flag', 'eq', 0))).to.eq(false);
      expect(await ev(cmp('flag', 'ne', 0))).to.eq(true);
      expect(await ev({ op: 'not', arg: cmp('flag', 'eq', 0) })).to.eq(true);
      expect(await ev(cmp('n', 'eq', true), { n: 1 })).to.eq(true);
      expect(await ev(cmp('n', 'eq', true), { n: 0 })).to.eq(false);
      for (const n of [2, -1, 0.5]) {
        expect(await ev(cmp('flag', 'eq', n)), `flag eq ${n}`).to.eq(null);
        expect(await ev(cmp('n', 'ne', true), { n }), `${n} ne true`).to.eq(null);
      }
      expect(await ev(cmp('flag', 'in', [0, 1]))).to.eq(true);
      expect(await ev(cmp('flag', 'in', [0]))).to.eq(false);
      expect(await ev(cmp('flag', 'nin', [0]))).to.eq(true);
      expect(await ev(cmp('flag', 'in', [2]))).to.eq(null);
      expect(await ev(cmp('flag', 'in', ['1']))).to.eq(null);
      expect(await ev(cmp('flag', 'eq', '1'))).to.eq(null);
    });

    it('booleans do not order: lt, lte, gt, gte are UNKNOWN, also against 0 and 1', async () => {
      for (const c of ['lt', 'lte', 'gt', 'gte']) {
        for (const v of [true, false, 0, 1]) {
          expect(await ev(cmp('flag', c, v)), `flag ${c} ${String(v)}`).to.eq(null);
          expect(await ev({ op: 'not', arg: cmp('flag', c, v) }), `not flag ${c} ${String(v)}`).to.eq(null);
        }
        expect(await ev(cmp('n', c, false), { n: 1 }), `1 ${c} false`).to.eq(null);
      }
    });

    it('an invalid Date field is NULL; one outside the years 0000-9999 does not compare', async () => {
      const invalid = { d: new Date(Number.NaN) };
      expect(await ev(cmp('d', 'null'), invalid)).to.eq(true);
      expect(await ev(cmp('d', 'notnull'), invalid)).to.eq(false);
      expect(await ev(cmp('d', 'eq', 'x'), invalid)).to.eq(null);
      const far = { d: new Date('+010000-01-01T00:00:00.000Z') };
      expect(await ev(cmp('d', 'notnull'), far)).to.eq(true);
      expect(await ev(cmp('d', 'gt', '2026-01-01T00:00:00.000Z'), far)).to.eq(null);
      expect(await ev(cmp('d', 'eq', far.d.toISOString()), far)).to.eq(null);
    });

    it('a non-finite number literal is missing: UNKNOWN in every polarity', async () => {
      for (const v of [Number.NaN, Infinity, -Infinity]) {
        for (const c of ['eq', 'ne', 'lt']) {
          expect(await ev(cmp('s', c, v), { s: '1' }), `${c} ${v}`).to.eq(null);
          expect(await ev({ op: 'not', arg: cmp('size', c, v) }), `not ${c} ${v}`).to.eq(null);
        }
      }
    });

    it('agrees with the engine on cmp leaves over scalar fields and values (property)', async () => {
      let current: ResourceFilter = TRUE;
      const engine = new Authorizer({
        domain: 'root',
        registry: new FakePermissionRegistry(['doc:read']),
        models: [new StaticModel({ name: 'm1', votes: () => ({ permitWhen: current }) })],
        combine: fixtureDsl.combine('deny-overrides', 'm1'),
      });
      const allowed = async (f: ResourceFilter, subject: unknown): Promise<boolean> => {
        current = f;
        return (await engine.check({ principal: alice, permission: 'doc:read', resource: ref, subject }, { cache: new Map() })).allowed;
      };
      const engineTruth = async (f: ResourceFilter, subject: unknown): Promise<Kleene> => ((await allowed(f, subject)) ? true : (await allowed({ op: 'not', arg: f }, subject)) ? false : null);

      const numberString = fc.oneof(fc.integer({ min: -20, max: 20 }).map(String), fc.double({ noNaN: true }).map(String), fc.constantFrom('010', '1.0', '1e21', '1e+21', '-0', ' 1', '', 'NaN', 'Infinity', '0x1'));
      const scalar = fc.oneof(numberString, fc.string({ maxLength: 3 }), fc.integer({ min: -2, max: 2 }), fc.double(), fc.boolean());
      const field = fc.oneof(scalar, fc.constant(null), fc.constant(undefined), fc.date({ noInvalidDate: false }), fc.constantFrom(new Date('2026-01-01T00:00:00.000Z'), new Date('+010000-01-01T00:00:00.000Z')));
      const listItem = fc.oneof(numberString, fc.string({ maxLength: 3 }), fc.integer({ min: -2, max: 2 }));
      const leaf = fc.oneof(
        fc.record({ c: fc.constantFrom('eq', 'ne', 'lt', 'lte', 'gt', 'gte'), value: scalar }),
        fc.record({ c: fc.constantFrom('in', 'nin'), value: fc.array(listItem, { minLength: 1, maxLength: 3 }) }),
        fc.record({ c: fc.constantFrom('null', 'notnull'), value: fc.constant(undefined) }),
      );
      await fc.assert(
        fc.asyncProperty(field, leaf, async (v, { c, value }) => {
          const f = cmp('v', c, value as Value);
          const subject = { v };
          expect(await ev(f, subject), JSON.stringify({ v: v instanceof Date ? `Date(${v.getTime()})` : v, c, value })).to.eq(await engineTruth(f, subject));
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('{ ref } values', () => {
    it('principal.*, actor.* (default: the principal), env.*', async () => {
      expect(await ev(cmp('pool', 'eq', { ref: 'principal.attributes.pool' }))).to.eq(true);
      expect(await ev(cmp('owner', 'eq', { ref: 'principal.id' }))).to.eq(true);
      expect(await ev(cmp('kind', 'eq', { ref: 'actor.type' }), { kind: 'user' })).to.eq(true);
      const agent = withAttributes(userPrincipal('bot'), {});
      expect(await ev(cmp('kind', 'eq', { ref: 'actor.id' }), { kind: 'bot' }, { actor: agent })).to.eq(true);
      expect(await ev(cmp('size', 'lt', { ref: 'env.limit' }), row, { env: { limit: 20 } })).to.eq(true);
      expect(await ev(cmp('size', 'in', { ref: 'principal.attributes.tags' }), { size: 'a' })).to.eq(true);
    });

    it('scope.<type>.<path> reads the nearest ancestor of that type', async () => {
      const org = { type: 'org', id: 'o1' };
      const extra: Partial<FilterEnv> = {
        ancestors: async () => [ref, { type: 'project', id: 'p1' }, org, GLOBAL],
        attributes: async (r) => (r.type === 'org' ? { policies: { maxSize: 50 } } : {}),
      };
      expect(await ev(cmp('size', 'lt', { ref: 'scope.org.policies.maxSize' }), row, extra)).to.eq(true);
      expect(await ev(cmp('size', 'lt', { ref: 'scope.org.policies.other' }), row, extra)).to.eq(null);
      expect(await ev(cmp('size', 'lt', { ref: 'scope.team.policies.maxSize' }), row, extra)).to.eq(null);
      expect(await ev(cmp('size', 'lt', { ref: 'scope.org.policies.maxSize' }), row, { ancestors: async () => null })).to.eq(null);
    });

    it('an unresolved or malformed ref is UNKNOWN', async () => {
      expect(await ev(cmp('pool', 'eq', { ref: 'principal.attributes.none' }))).to.eq(null);
      expect(await ev(cmp('pool', 'eq', { ref: 'principal.attributes.nested' }))).to.eq(null);
      expect(await ev(cmp('pool', 'eq', { ref: 'principal.__proto__' }))).to.eq(null);
      expect(await ev(cmp('pool', 'eq', { ref: 'resource.pool' }))).to.eq(null);
      expect(await ev(cmp('pool', 'eq', { ref: 'env.none' }))).to.eq(null);
      expect(await ev(cmp('pool', 'eq', { ref: 'principal.id', extra: 1 } as unknown as Value))).to.eq(null);
      expect(await ev({ op: 'not', arg: cmp('pool', 'eq', { ref: 'principal.attributes.none' }) })).to.eq(null);
    });

    it('denies exactly where bindRefs (fail closed by polarity) denies', async () => {
      const missing = { ref: 'principal.attributes.none' };
      const filters: ResourceFilter[] = [
        cmp('pool', 'eq', missing),
        { op: 'not', arg: cmp('pool', 'eq', missing) },
        raw('or', cmp('pool', 'eq', missing), cmp('owner', 'eq', 'alice')),
        { op: 'not', arg: raw('or', cmp('pool', 'eq', missing), cmp('owner', 'eq', 'bob')) },
        raw('and', { op: 'not', arg: cmp('pool', 'ne', missing) }, cmp('owner', 'eq', 'alice')),
        cmp('flag', 'in', [true] as unknown as Value),
        { op: 'not', arg: cmp('owner', 'nin', ['alice', null] as unknown as Value) },
        raw('or', cmp('owner', 'in', ['alice', NaN]), cmp('owner', 'eq', 'bob')),
        cmp('owner', 'in', ['alice', 5]),
        cmp('owner', 'nin', ['bob', 5]),
      ];
      for (const list of badLists) {
        filters.push(cmp('owner', 'in', list as Value), cmp('owner', 'nin', list as Value), { op: 'not', arg: cmp('owner', 'in', list as Value) }, { op: 'not', arg: cmp('owner', 'nin', list as Value) });
      }
      for (const f of filters) {
        const bound = bindRefs(f, { principal: alice, env: {} });
        expect(isAllowed(await ev(f)), JSON.stringify(f)).to.eq(isAllowed(await ev(bound)));
      }
    });
  });

  describe('relation, under, native', () => {
    it('relation asks the resolver for the principal, the ref and the subject', async () => {
      const seen: unknown[] = [];
      const owner = new FakeRelationResolver('doc', 'owner', (p, r, s) => {
        seen.push([p.id, r, s]);
        return (s as typeof row).owner === p.id;
      });
      const relation = (type: string, name: string) => (type === owner.type && name === owner.relation ? owner : undefined);
      expect(await ev({ op: 'relation', relation: 'owner' }, row, { relation })).to.eq(true);
      expect(await ev({ op: 'relation', relation: 'owner' }, { ...row, owner: 'bob' }, { relation })).to.eq(false);
      expect(seen[0]).to.deep.eq(['alice', ref, row]);
      expect(await ev({ op: 'relation', relation: 'editor' }, row, { relation })).to.eq(null);
    });

    it('under: an ancestor (or the row itself) in scopes; no ancestors = UNKNOWN; [] = FALSE', async () => {
      const ancestors = async () => [ref, { type: 'folder', id: 'd1' }, GLOBAL];
      expect(await ev({ op: 'under', scopes: [{ type: 'folder', id: 'd1' }] }, row, { ancestors })).to.eq(true);
      expect(await ev({ op: 'under', scopes: [ref] }, row, { ancestors })).to.eq(true);
      expect(await ev({ op: 'under', scopes: [{ type: 'folder', id: 'd2' }] }, row, { ancestors })).to.eq(false);
      expect(await ev({ op: 'under', scopes: [{ type: 'folder' }] }, row, { ancestors })).to.eq(true);
      expect(await ev({ op: 'under', scopes: [{ type: 'project' }] }, row, { ancestors })).to.eq(false);
      expect(await ev({ op: 'under', scopes: [{ type: 'folder', id: 'd1' }] }, row, { ancestors: async () => null })).to.eq(null);
      expect(await ev({ op: 'under', scopes: [] }, row, { ancestors: async () => null })).to.eq(false);
    });

    it('under without an ancestors source uses the unregistered-type default [ref, GLOBAL]', async () => {
      expect(await ev({ op: 'under', scopes: [GLOBAL] })).to.eq(true);
      expect(await ev({ op: 'under', scopes: [{ type: 'folder', id: 'd1' }] })).to.eq(false);
    });

    it('native ops run their NativeFilter with args, subject, ref and context; unregistered = UNKNOWN', async () => {
      const seen: unknown[] = [];
      class Big extends NativeFilter {
        readonly op = 'native:test.big' as const;
        async matches(args: unknown, subject: unknown, r: ResourceRef, ctx: EvaluationContext) {
          seen.push([args, r, ctx.domain]);
          return (subject as typeof row).size > (args as { min: number }).min;
        }
      }
      const context = fakeEvaluationContext({ domain: 'd1' });
      const f: ResourceFilter = { op: 'native:test.big', args: { min: 5 } };
      expect(await ev(f, row, { nativeFilters: [new Big()], context })).to.eq(true);
      expect(await ev({ op: 'native:test.big', args: { min: 50 } }, row, { nativeFilters: [new Big()], context })).to.eq(false);
      expect(seen[0]).to.deep.eq([{ min: 5 }, ref, 'd1']);
      expect(await ev(f)).to.eq(null);
    });

    it('falls back to the context for ancestors, attributes, relations and native filters', async () => {
      class Yes extends NativeFilter {
        readonly op = 'native:test.yes' as const;
        matches() {
          return true;
        }
      }
      const context = fakeEvaluationContext({
        relations: [new FakeRelationResolver('doc', 'owner', () => true)],
        nativeFilters: [new Yes()],
      });
      expect(await ev({ op: 'relation', relation: 'owner' }, row, { context })).to.eq(true);
      expect(await ev({ op: 'native:test.yes' }, row, { context })).to.eq(true);
      expect(await ev({ op: 'under', scopes: [GLOBAL] }, row, { context })).to.eq(true);
    });

    it('an unknown op throws', async () => {
      let err: unknown;
      try {
        await ev({ op: 'xor' } as unknown as ResourceFilter);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(TypeError);
    });

    it('a resolver or native filter answering a non-boolean throws a TypeError naming it, also under not', async () => {
      for (const answer of [undefined, null, 1, 'yes']) {
        const resolver = new FakeRelationResolver('doc', 'owner', () => answer as unknown as boolean);
        const relation = () => resolver;
        for (const f of [{ op: 'relation', relation: 'owner' }, { op: 'not', arg: { op: 'relation', relation: 'owner' } }] as ResourceFilter[]) {
          const err = await rejection(ev(f, row, { relation }));
          expect(err, String(answer)).to.be.instanceOf(TypeError);
          expect((err as Error).message).to.contain('doc#owner');
        }
        class Odd extends NativeFilter {
          readonly op = 'native:test.odd' as const;
          matches() {
            return answer as unknown as boolean;
          }
        }
        for (const f of [{ op: 'native:test.odd' }, { op: 'not', arg: { op: 'native:test.odd' } }] as ResourceFilter[]) {
          const err = await rejection(ev(f, row, { nativeFilters: [new Odd()] }));
          expect(err, String(answer)).to.be.instanceOf(TypeError);
          expect((err as Error).message).to.contain('native:test.odd');
        }
      }
    });
  });

  describe('attribute reader', () => {
    it('default reads own properties along a dotted path only', async () => {
      class Row {
        own = 'x';
        get computed() {
          return 'y';
        }
      }
      expect(await ev(cmp('own', 'eq', 'x'), new Row())).to.eq(true);
      expect(await ev(cmp('computed', 'eq', 'y'), new Row())).to.eq(null);
      expect(await ev(cmp('constructor', 'notnull'), new Row())).to.eq(false);
    });

    it('a custom reader replaces it', async () => {
      expect(await ev(cmp('anything', 'eq', 'v'), row, { attribute: () => 'v' })).to.eq(true);
    });
  });

  it('agrees with simplify on the core rewrites', async () => {
    const filters: ResourceFilter[] = [
      raw('and', T, U),
      raw('or', F, U),
      raw('and', U, raw('and', U, cmp('owner', 'eq', 'alice'))),
      raw('or', U, U),
      { op: 'not', arg: { op: 'not', arg: U } },
      cmp('deleted', 'in', []),
      cmp('deleted', 'nin', []),
      { op: 'under', scopes: [] },
      and(cmp('owner', 'eq', 'alice'), or(U, not(cmp('size', 'gt', 3)))),
    ];
    for (const f of filters) {
      expect(await ev(simplify(f)), JSON.stringify(f)).to.eq(await ev(f));
    }
  });
});

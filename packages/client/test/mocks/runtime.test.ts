import 'mocha';
import { expect } from 'chai';
import * as fc from 'fast-check';
import { formatPredicate, isInt32, isInt64 } from '../../src/formats/index.js';
import {
  createMockClient,
  mockCursorPage,
  MockNotImplemented,
  mockFrom,
  mockIssue,
  mockPage,
  MockUnsupported,
  Rng,
  type MockSchema,
} from '../../src/mocks/index.js';
import { FORMAT_SAMPLERS } from '../../src/mocks/formats.js';
import { parsePattern, samplePattern } from '../../src/mocks/pattern.js';

const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
const seeds = fc.integer({ min: 0, max: 0xffffffff });

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) {
      out.push(String(key));
      keysDeep((value as Record<string, unknown>)[String(key)], out);
    }
  }
  return out;
}

describe('@spinajs/client/mocks: runtime', function () {
  this.timeout(60000);

  describe('Rng', () => {
    it('is deterministic per seed and derives children from the seed and a key only', () => {
      const a = new Rng(7);
      const b = new Rng(7);
      expect([a.next(), a.next(), a.int(1, 6)]).to.deep.equal([b.next(), b.next(), b.int(1, 6)]);
      expect(new Rng(7).child('name').next()).to.equal(a.child('name').next());
      expect(new Rng(7).child('name').next()).to.not.equal(new Rng(7).child('email').next());
    });

    it('keeps int() inside its bounds', () => {
      fc.assert(
        fc.property(seeds, fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 50 }), (seed, lo, span) => {
          const n = new Rng(seed).int(lo, lo + span);
          return Number.isInteger(n) && n >= lo && n <= lo + span;
        }),
      );
    });
  });

  describe('format samplers', () => {
    for (const name of Object.keys(FORMAT_SAMPLERS)) {
      it(`${name}: every sample passes the @spinajs/client/formats predicate`, () => {
        const check = formatPredicate(name)!;
        expect(check, name).to.be.a('function');
        fc.assert(fc.property(seeds, fc.integer({ min: 0, max: 40 }), (seed, min) => check(FORMAT_SAMPLERS[name](new Rng(seed), min))), { numRuns: 300 });
      });
    }

    it('covers every string format the server knows, decimal included', () => {
      const known = ['date', 'time', 'date-time', 'duration', 'uri', 'uri-reference', 'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid'];
      const more = ['json-pointer', 'json-pointer-uri-fragment', 'relative-json-pointer', 'byte', 'password', 'binary', 'decimal'];
      expect(Object.keys(FORMAT_SAMPLERS).sort()).to.deep.equal([...known, ...more].sort());
    });

    it('keeps int32 and int64 numbers in their range', () => {
      const schemas = { A: { type: 'integer', format: 'int32', minimum: -1e12 }, B: { type: 'integer', format: 'int64', maximum: 1e300 } };
      fc.assert(fc.property(seeds, (seed) => isInt32(mockFrom<number>(schemas, 'A', undefined, { seed })) && isInt64(mockFrom<number>(schemas, 'B', undefined, { seed }))));
    });

    it('uses an app sampler from options.formats, checked against the format', () => {
      const schemas = { A: { type: 'string', format: 'email' } };
      expect(mockFrom(schemas, 'A', undefined, { formats: { email: (rng) => `faker${rng.int(1, 1)}@example.org` } })).to.equal('faker1@example.org');
      expect(() => mockFrom(schemas, 'A', undefined, { formats: { email: () => 'not an email' } })).to.throw(/email/);
    });
  });

  describe('pattern sampler', () => {
    const subset = [
      '^[a-z]+$',
      '^-?\\d+$',
      '^[A-Z]{2}-\\d{3,5}$',
      '^(foo|bar)+baz?$',
      '^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$',
      '^\\w+@\\w+\\.(com|org)$',
      'abc',
      '^[^\\s,]{1,8}$',
      '^\\+?[1-9]\\d{1,14}$',
      '^a.c\\.\\x41\\u0042\\u{43}[\\d\\-_]*$',
      '^(a|bc|)$',
      '^x{0}y{2,}z*?$',
    ];
    for (const source of subset) {
      it(`samples /${source}/u`, () => {
        const node = parsePattern(source);
        expect(node, 'in the subset').to.not.equal(undefined);
        const regex = new RegExp(source, 'u');
        fc.assert(fc.property(seeds, (seed) => regex.test(samplePattern(node!, new Rng(seed)))), { numRuns: 200 });
      });
    }

    for (const source of ['(?=a)a', 'a(?!b)', '(?<=a)b', '(a)\\1', '\\bword', '\\p{L}+', 'a^b', '[[:alpha:]]', '(?<name>a)\\k<name>', '\\c']) {
      it(`refuses /${source}/ as outside the subset`, () => {
        expect(parsePattern(source)).to.equal(undefined);
      });
    }

    it('falls back on examples, default and const for a pattern outside the subset', () => {
      const lookahead = '^(?=.*\\d)[a-z0-9]{6,}$';
      expect(mockFrom({ A: { type: 'string', pattern: lookahead, examples: ['nodigits', 'abc123'] } }, 'A')).to.equal('abc123');
      expect(mockFrom({ A: { type: 'string', pattern: lookahead, default: 'zzz999' } }, 'A')).to.equal('zzz999');
      expect(mockFrom({ A: { type: 'string', pattern: lookahead, const: 'q1w2e3' } }, 'A')).to.equal('q1w2e3');
      expect(() => mockFrom({ A: { type: 'string', pattern: lookahead } }, 'A')).to.throw(MockUnsupported, /MOCK001/);
    });

    it('honours lengths together with a pattern', () => {
      const schemas = { A: { type: 'string', pattern: '^[a-z]+$', minLength: 12, maxLength: 14 } };
      fc.assert(fc.property(seeds, (seed) => /^[a-z]{12,14}$/.test(mockFrom<string>(schemas, 'A', undefined, { seed }))), { numRuns: 100 });
    });
  });

  describe('mockFrom', () => {
    const user: Record<string, MockSchema> = {
      User: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 }, email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 2, maxLength: 5 }, tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
        required: ['id', 'email'],
        additionalProperties: false,
      },
    };

    it('gives deep-equal values for the same seed, schema and overrides', () => {
      fc.assert(fc.property(seeds, (seed) => JSON.stringify(mockFrom(user, 'User', { id: 5 }, { seed })) === JSON.stringify(mockFrom(user, 'User', { id: 5 }, { seed }))));
      expect(mockFrom(user, 'User')).to.deep.equal(mockFrom(user, 'User', undefined, { seed: 1 }));
    });

    it('leaves the other properties unchanged when an optional property is added', () => {
      const props = (user.User as { properties: Record<string, unknown> }).properties;
      const wider = { User: { ...(user.User as object), properties: { ...props, extra: { type: 'number' } } } };
      fc.assert(
        fc.property(seeds, (seed) => {
          const before = mockFrom<Record<string, unknown>>(user, 'User', undefined, { seed, optional: 'all' });
          const { extra, ...after } = mockFrom<Record<string, unknown>>(wider, 'User', undefined, { seed, optional: 'all' });
          return typeof extra === 'number' && JSON.stringify(after) === JSON.stringify(before);
        }),
      );
    });

    it('includes every optional property with optional: all, and flips a seeded coin otherwise', () => {
      expect(Object.keys(mockFrom(user, 'User', undefined, { optional: 'all' }))).to.deep.equal(['id', 'email', 'name', 'tags']);
      const counts = new Set(Array.from({ length: 40 }, (_, seed) => Object.keys(mockFrom<object>(user, 'User', undefined, { seed })).length));
      expect([...counts].sort()).to.deep.equal([2, 3, 4]);
    });

    it('merges overrides over the generated object, without inherited-name keys', () => {
      const overrides = JSON.parse('{"id": 42, "__proto__": {"polluted": true}, "constructor": 1}') as Record<string, unknown>;
      const value = mockFrom<Record<string, unknown>>(user, 'User', overrides);
      expect(value.id).to.equal(42);
      expect(Object.getPrototypeOf(value)).to.equal(Object.prototype);
      expect(keysDeep(value).filter((k) => FORBIDDEN.includes(k))).to.deep.equal([]);
    });

    it('stops recursion at maxDepth, optional branches first', () => {
      const tree = {
        Category: {
          type: 'object',
          properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: 'Category' } }, parent: { anyOf: [{ $ref: 'Category' }, { type: 'null' }] } },
          required: ['name'],
          additionalProperties: false,
        },
      };
      const depth = (v: unknown): number => (typeof v === 'object' && v !== null ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0);
      for (const maxDepth of [1, 2, 3, 4]) {
        fc.assert(fc.property(seeds, (seed) => depth(mockFrom(tree, 'Category', undefined, { seed, optional: 'all', maxDepth })) <= 2 * maxDepth + 1), { numRuns: 50 });
      }
    });

    it('never writes a key named __proto__, constructor or prototype, and refuses a schema that needs one', () => {
      const optional = { A: { type: 'object', properties: { prototype: { type: 'string' }, constructor: {}, ok: { type: 'string' } }, required: ['ok'] } };
      expect(keysDeep(mockFrom(optional, 'A', undefined, { optional: 'all' }))).to.deep.equal(['ok']);
      const required = JSON.parse('{"A": {"type": "object", "properties": {"prototype": {"type": "string"}}, "required": ["prototype"]}}') as Record<string, MockSchema>;
      expect(() => mockFrom(required, 'A')).to.throw(MockUnsupported, /prototype/);
      const proto = JSON.parse('{"A": {"type": "object", "properties": {"__proto__": {"type": "string"}}}}') as Record<string, MockSchema>;
      expect(() => mockFrom(proto, 'A')).to.throw(MockUnsupported, /__proto__/);
      expect(() => mockFrom({ A: { type: 'object', properties: { constructor: { type: 'number' } } } }, 'A')).to.throw(MockUnsupported, /constructor/);
      const enumObject = JSON.parse('{"A": {"enum": [{"__proto__": 1}, {"ok": 1}]}}') as Record<string, MockSchema>;
      expect(mockFrom(enumObject, 'A')).to.deep.equal({ ok: 1 });
    });

    it('always writes a declared property named after an Object.prototype member, which Ajv would read as inherited', () => {
      const schemas = { A: { type: 'object', properties: { toString: { type: 'string' }, valueOf: { type: 'number' }, ok: { type: 'string' } } } };
      fc.assert(fc.property(seeds, (seed) => ['toString', 'valueOf'].every((k) => Object.hasOwn(mockFrom<object>(schemas, 'A', undefined, { seed, maxDepth: 0 }), k))));
    });

    it('never produces a non-finite number, whatever the limits', () => {
      const limit = fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: undefined });
      let given = 0;
      fc.assert(
        fc.property(seeds, limit, limit, fc.boolean(), fc.boolean(), (seed, a, b, exclusive, integer) => {
          const [lo, hi] = a !== undefined && b !== undefined && a > b ? [b, a] : [a, b];
          const schema = { type: integer ? 'integer' : 'number', ...(lo !== undefined ? { [exclusive ? 'exclusiveMinimum' : 'minimum']: lo } : {}), ...(hi !== undefined ? { maximum: hi } : {}) };
          try {
            const n = mockFrom<number>({ N: schema }, 'N', undefined, { seed });
            given++;
            return Number.isFinite(n) && (lo === undefined || (exclusive ? n > lo : n >= lo)) && (hi === undefined || n <= hi);
          } catch (e) {
            // An empty range has no value to give; it says so instead of returning a wrong one.
            return e instanceof Error && e.name === 'MockError';
          }
        }),
        { numRuns: 2000 },
      );
      expect(given).to.be.greaterThan(1600);
    });

    it('reports MOCK001 for keywords it cannot honour, through $ref too', () => {
      const schemas = { A: { type: 'object', properties: { b: { $ref: 'B' } } }, B: { type: 'string', not: { const: 'x' } }, C: { type: 'string' } };
      expect(mockIssue(schemas, 'B')).to.deep.include({ schema: 'B', pointer: '/not' });
      expect(mockIssue(schemas, 'A')).to.deep.include({ schema: 'A', pointer: '/properties/b/$ref' });
      expect(mockIssue(schemas, 'C')).to.equal(undefined);
      expect(() => mockFrom(schemas, 'A')).to.throw(MockUnsupported, /MOCK001/);
      for (const schema of [{ if: { type: 'string' } }, { minimum: { $data: '1/x' } }, { contains: {} }, { myKeyword: true }, { $ref: 'Missing' }, { type: 'date' }, { pattern: '(' }]) {
        expect(mockIssue({ X: schema }, 'X'), JSON.stringify(schema)).to.not.equal(undefined);
      }
    });

    it('picks a oneOf branch only when the branches cannot both match', () => {
      const circle = { type: 'object', properties: { kind: { const: 'circle' }, r: { type: 'number' } }, required: ['kind', 'r'] };
      const square = { type: 'object', properties: { kind: { const: 'square' }, side: { type: 'number' } }, required: ['kind', 'side'] };
      expect(mockIssue({ F: { oneOf: [{ $ref: 'C' }, { $ref: 'S' }, { type: 'null' }] }, C: circle, S: square }, 'F')).to.equal(undefined);
      expect(mockIssue({ F: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 2 }] } }, 'F')).to.deep.include({ pointer: '/oneOf' });
    });
  });

  describe('mockPage and mockCursorPage', () => {
    it('fills an offset page from the item index', () => {
      expect(mockPage((i) => i, { total: 45, page: 3, pageSize: 20 })).to.deep.equal({ items: [40, 41, 42, 43, 44], total: 45 });
      expect(mockPage((i) => i, { total: 3, page: 0, pageSize: 2, firstPage: 0 })).to.deep.equal({ items: [0, 1], total: 3 });
      expect(mockPage((i) => i, { pageSize: 2 })).to.deep.equal({ items: [0, 1], total: 2 });
      expect(mockPage((i) => i, { total: 1, page: 5 })).to.deep.equal({ items: [], total: 1 });
      expect(() => mockPage((i) => i, { pageSize: -1 })).to.throw(RangeError);
    });

    it('fills a cursor page', () => {
      expect(mockCursorPage((i) => `u${i}`, { count: 2, next: 'abc' })).to.deep.equal({ items: ['u0', 'u1'], next: 'abc' });
      expect(mockCursorPage((i) => i, {}).next).to.equal(null);
      expect(mockCursorPage((i) => i, {}).items).to.have.length(20);
    });
  });

  describe('createMockClient', () => {
    interface Client {
      users: { get(id: number): Promise<{ id: number }>; remove(id: number): Promise<void> };
    }
    const schemas = { User: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } };
    const routes = { users: { get: { $ref: 'User' }, remove: null } };

    it('calls an implemented method with its arguments', async () => {
      const calls: unknown[] = [];
      const client = createMockClient<Client>(routes, schemas, { users: { get: (id: number) => (calls.push(id), Promise.resolve({ id })) } });
      expect(await client.users.get(7)).to.deep.equal({ id: 7 });
      expect(calls).to.deep.equal([7]);
    });

    it('rejects an unimplemented method with MockNotImplemented', async () => {
      const client = createMockClient<Client>(routes, schemas, {});
      const error = await client.users.get(1).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(MockNotImplemented);
      expect((error as Error).message).to.equal('createMockAppClient: users.get is not implemented; pass it in the first argument');
      expect((error as MockNotImplemented).route).to.equal('users.get');
    });

    it("answers with mock data under fallback: 'mock', and with undefined for a void route", async () => {
      const client = createMockClient<Client>(routes, schemas, {}, { fallback: 'mock', seed: 3 });
      expect(await client.users.get(1)).to.deep.equal(mockFrom(schemas, 'User', undefined, { seed: 3 }));
      expect(await client.users.remove(1)).to.equal(undefined);
    });

    it('ignores inherited names in the implementation', async () => {
      const impl = JSON.parse('{"users": {"__proto__": {"get": 1}}}') as object;
      const client = createMockClient<Client>(routes, schemas, impl);
      await client.users.get(1).then(
        () => expect.fail('resolved'),
        (e: unknown) => expect(e).to.be.instanceOf(MockNotImplemented),
      );
    });
  });
});

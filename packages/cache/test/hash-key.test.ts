import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { cache, hashKey } from '../src/index.js';

const WIDE = 'ā';

// Each gives a string equal to its input that V8 holds two-byte, while a literal of the same text is one-byte.
const REBUILT: Record<string, (s: string) => string> = {
  slice: (s) => (WIDE + s).slice(1),
  split: (s) => `${WIDE}|${s}`.split('|')[1],
  replace: (s) => (WIDE + s).replace(WIDE, ''),
  buffer: (s) => Buffer.from(WIDE + s).toString('utf8').slice(1),
  json: (s) => String(JSON.parse(JSON.stringify(WIDE + s))).slice(1),
  concat: (s) => (WIDE + s.slice(0, 4)).slice(1) + s.slice(4),
};

const TEXTS = {
  ascii: 'SELECT * FROM users WHERE id = ?',
  polish: 'zażółć gęślą jaźń, padded past thirteen',
  astral: 'SELECT \u{1F600} FROM \u{1D518} WHERE id = ?',
};

const differ = (a: unknown[], b: unknown[]): boolean => hashKey(a) !== hashKey(b);

describe('hashKey', () => {
  it('hashes a string by its value, however the string was built', () => {
    for (const [text, value] of Object.entries(TEXTS)) {
      for (const [how, rebuild] of Object.entries(REBUILT)) {
        const other = rebuild(value);
        expect(other, `${text} ${how}`).to.eq(value);
        expect(hashKey([other]), `${text} ${how}`).to.eq(hashKey([value]));
        expect(hashKey([{ [other]: [other] }]), `${text} ${how} nested`).to.eq(hashKey([{ [value]: [value] }]));
      }
    }
    const fragment = 'Zażółć gęślą jaźń|SELECT * FROM users WHERE id = ?'.split('|')[1];
    expect(hashKey([fragment])).to.eq(hashKey([TEXTS.ascii]));
  });

  it('ignores the insertion order of object keys, map entries and set items', () => {
    expect(hashKey([{ a: 1, b: { c: 2, d: 3 } }])).to.eq(hashKey([{ b: { d: 3, c: 2 }, a: 1 }]));
    expect(hashKey([new Map<unknown, unknown>([['a', 1], [2, 'b']])])).to.eq(hashKey([new Map<unknown, unknown>([[2, 'b'], ['a', 1]])]));
    expect(hashKey([new Set(['a', 1])])).to.eq(hashKey([new Set([1, 'a'])]));
    expect(hashKey([{ __proto__: null, a: 1 }])).to.eq(hashKey([{ a: 1 }]));
  });

  it('keys a number by its value and apart from a bigint or a string', () => {
    expect(hashKey([0])).to.eq(hashKey([-0]));
    expect(hashKey([NaN])).to.eq(hashKey([Number('x')]));
    expect(hashKey([1])).to.eq(hashKey([1.0]));
    expect(differ([1], [1n])).to.eq(true);
    expect(differ([1], ['1'])).to.eq(true);
    expect(differ([1n], ['1'])).to.eq(true);
    expect(differ([NaN], ['NaN'])).to.eq(true);
    expect(differ([Infinity], [-Infinity])).to.eq(true);
    expect(differ([true], ['true'])).to.eq(true);
    expect(differ([new Date(0)], [0])).to.eq(true);
  });

  it('keeps apart parts an application holds different', () => {
    expect(differ(['a', 'b'], ['ab'])).to.eq(true);
    expect(differ(['a,b'], ['a', 'b'])).to.eq(true);
    expect(differ([['a'], 'b'], ['a', ['b']])).to.eq(true);
    expect(differ([[]], [])).to.eq(true);
    expect(differ([''], [])).to.eq(true);
    expect(differ(['\uD800'], ['\uDC00'])).to.eq(true);
    expect(differ([{ 0: 'a' }], [['a']])).to.eq(true);
    expect(differ([new Map([['a', 1]])], [[['a', 1]]])).to.eq(true);
    expect(differ([new Set(['a'])], [['a']])).to.eq(true);
    expect(differ([Buffer.from([1])], [[1]])).to.eq(true);
    expect(differ([new Uint8Array([1])], [new Int8Array([1])])).to.eq(true);
    expect(hashKey([Buffer.from([1, 2])])).to.eq(hashKey([new Uint8Array([1, 2])]));
  });

  it('holds undefined apart from null, and an undefined property the same as a missing one', () => {
    expect(differ([undefined], [null])).to.eq(true);
    expect(differ([undefined], [])).to.eq(true);
    expect(differ([{ a: null }], [{}])).to.eq(true);
    expect(hashKey([{ a: undefined, b: 1 }])).to.eq(hashKey([{ b: 1 }]));
    const holed: unknown[] = [1];
    holed[2] = 2;
    expect(hashKey([holed])).to.eq(hashKey([[1, undefined, 2]]));
  });

  it('keys a date by its time and refuses what has no value equality', () => {
    expect(hashKey([new Date(5)])).to.eq(hashKey([new Date(5)]));
    expect(differ([new Date(5)], [new Date(6)])).to.eq(true);
    class Id {
      public constructor(public readonly value: string) {}
    }
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const shared = { a: 1 };
    expect(() => hashKey([() => 1])).to.throw(InvalidArgument, 'a function');
    expect(() => hashKey([Symbol('s')])).to.throw(InvalidArgument, 'a symbol');
    expect(() => hashKey([{ id: new Id('5') }])).to.throw(InvalidArgument, '$[0].id is an instance of Id');
    expect(() => hashKey([cyclic])).to.throw(InvalidArgument, '$[0].self is a cycle');
    expect(hashKey([shared, shared])).to.eq(hashKey([{ a: 1 }, { a: 1 }]));
  });
});

describe('hashKey through cache()', () => {
  const OPTIONS = { ttl: '1m' };
  const query = TEXTS.ascii;
  const rebuilt = REBUILT.slice(query);
  let app: TestApp;
  let runs: number;
  const compute = async (): Promise<number> => {
    runs += 1;
    return runs;
  };

  beforeEach(async () => {
    app = await createTestApp({ config: { cache: { ttlJitter: 0, maxTtl: '10m', caches: { default: {} } } } });
    runs = 0;
  });

  afterEach(async () => {
    await app.dispose();
  });

  it('finds an entry by a key built from an equal string another way', async () => {
    await cache().wrap(hashKey(['users', query]), OPTIONS, compute);
    expect(await cache().wrap(hashKey(['users', rebuilt]), OPTIONS, compute)).to.eq(1);
    expect(runs).to.eq(1);
  });

  it('deletes an entry by a key built from an equal string another way', async () => {
    await cache().wrap(hashKey(['users', query]), OPTIONS, compute);
    await cache().delete(hashKey(['users', rebuilt]));
    expect(await cache().wrap(hashKey(['users', query]), OPTIONS, compute)).to.eq(2);
  });

  it('joins a running computation of a key built another way', async () => {
    const both = await Promise.all([cache().wrap(hashKey(['users', query]), OPTIONS, compute), cache().wrap(hashKey(['users', rebuilt]), OPTIONS, compute)]);
    expect(both).to.deep.eq([1, 1]);
    expect(runs).to.eq(1);
  });
});

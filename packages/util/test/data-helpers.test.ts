import { expect } from 'chai';
import { runInNewContext } from 'node:vm';
import {
  allMaybe,
  asciiLower,
  chunk,
  compareCodePoints,
  compareStrings,
  copyPlainData,
  deepEqual,
  deepFreeze,
  deepMerge,
  defineOwn,
  describeValue,
  escapeHtml,
  getOwnPath,
  isFiniteNumber,
  isNonNegativeInt,
  isStrictPlainObject,
  isStringArray,
  isUnsafeKey,
  isValidDate,
  jsonParse,
  jsonStringify,
  parseIsoInstant,
  quote,
  replacer,
  reviver,
  sortedUnique,
  stableStringify,
  thenMaybe,
  toEpochMs,
  truncate,
  UNSAFE_KEYS,
} from '../src/index.js';

const otherRealm = <T>(code: string): T => runInNewContext(code) as T;

describe('string helpers', () => {
  it('asciiLower folds ASCII letters only', () => {
    expect(asciiLower('AbC-Z09')).to.equal('abc-z09');
    // The Kelvin sign and the dotted capital I stay as they are.
    expect(asciiLower('Kİ')).to.equal('Kİ');
  });

  it('escapeHtml escapes the five HTML-special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).to.equal('&#60;a href=&#34;x&#34;&#62;Tom &#38; &#39;Jerry&#39;&#60;/a&#62;');
    expect(escapeHtml('plain')).to.equal('plain');
  });

  it('compareStrings is code-unit order', () => {
    expect(['b', 'a', 'B', '｡', '\u{1F600}'].sort(compareStrings)).to.deep.equal(['B', 'a', 'b', '\u{1F600}', '｡']);
    expect(compareStrings('a', 'a')).to.equal(0);
  });

  it('compareCodePoints puts characters above U+FFFF after U+E000-U+FFFF', () => {
    expect(['\u{1F600}', '｡', 'a'].sort(compareCodePoints)).to.deep.equal(['a', '｡', '\u{1F600}']);
    expect(compareCodePoints('ab', 'a')).to.be.greaterThan(0);
    expect(compareCodePoints('a', 'a')).to.equal(0);
    expect(compareCodePoints('a퟿', 'a𐀀')).to.be.lessThan(0);
  });

  it('quote JSON-quotes strings and never throws', () => {
    expect(quote('a"b')).to.equal('"a\\"b"');
    expect(quote(1)).to.equal('1');
    expect(quote(undefined)).to.equal('undefined');
    expect(quote(Symbol('s'))).to.equal('Symbol(s)');
    expect(quote(Object.create(null))).to.equal('[object Object]');
  });

  it('describeValue is short and runs no code of the value', () => {
    class Point {}
    let called = false;
    const sneaky = {
      get x() {
        called = true;
        return 1;
      },
      toString() {
        called = true;
        return 'x';
      },
    };
    expect(describeValue('x'.repeat(100))).to.equal(JSON.stringify('x'.repeat(63) + '…'));
    expect(describeValue([1, 2])).to.equal('array(2)');
    expect(describeValue({})).to.equal('object');
    expect(describeValue(Object.create(null))).to.equal('object');
    expect(describeValue(new Point())).to.equal('Point');
    expect(describeValue(new Map())).to.equal('Map');
    expect(describeValue(null)).to.equal('null');
    expect(describeValue(undefined)).to.equal('undefined');
    expect(describeValue(10n)).to.equal('10n');
    expect(describeValue(Symbol('s'))).to.equal('symbol');
    expect(describeValue(() => 1)).to.equal('function');
    expect(describeValue(sneaky)).to.equal('object');
    expect(called).to.be.false;
  });

  it('truncate with codePoints never splits a surrogate pair', () => {
    const s = '\u{1F600}\u{1F601}\u{1F602}';
    expect(truncate(s, 3, '…', { codePoints: true })).to.equal(s);
    expect(truncate(s, 2, '…', { codePoints: true })).to.equal('\u{1F600}…');
    expect(truncate(s, 1, '…', { codePoints: true })).to.equal('…');
    expect(truncate(s, 0, '…', { codePoints: true })).to.equal('');
    expect(truncate('abcdef', 4, '..', { codePoints: true })).to.equal('ab..');
    // Code-unit mode is unchanged.
    expect(truncate('the quick brown fox', 9)).to.equal('the quic…');
  });
});

describe('array helpers', () => {
  it('chunk accepts a readonly array', () => {
    const items: readonly number[] = Object.freeze([1, 2, 3]);
    expect(chunk(items, 2)).to.deep.equal([[1, 2], [3]]);
  });

  it('sortedUnique sorts and drops duplicates', () => {
    expect(sortedUnique(['b', 'a', 'b', 'c', 'a'])).to.deep.equal(['a', 'b', 'c']);
    expect(sortedUnique(new Set([3, 1, 2]))).to.deep.equal([1, 2, 3]);
    expect(sortedUnique(['\u{1F600}', '｡', '｡'], compareCodePoints)).to.deep.equal(['｡', '\u{1F600}']);
    expect(sortedUnique(['B', 'b', 'a'], (x, y) => compareStrings(x.toLowerCase(), y.toLowerCase()))).to.have.length(2);
  });
});

describe('type guards', () => {
  it('isStringArray', () => {
    expect(isStringArray(['a', ''])).to.be.true;
    expect(isStringArray([])).to.be.true;
    expect(isStringArray(['a', 1])).to.be.false;
    expect(isStringArray('a')).to.be.false;
    expect(isStringArray(['a', ''], { nonEmpty: true })).to.be.false;
    expect(isStringArray(['a'], { nonEmpty: true })).to.be.true;
  });

  it('isFiniteNumber and isNonNegativeInt', () => {
    expect(isFiniteNumber(1.5)).to.be.true;
    expect(isFiniteNumber(NaN)).to.be.false;
    expect(isFiniteNumber(Infinity)).to.be.false;
    expect(isFiniteNumber('1')).to.be.false;
    expect(isNonNegativeInt(0)).to.be.true;
    expect(isNonNegativeInt(7)).to.be.true;
    expect(isNonNegativeInt(-1)).to.be.false;
    expect(isNonNegativeInt(1.5)).to.be.false;
    expect(isNonNegativeInt(2 ** 53)).to.be.false;
    expect(isNonNegativeInt('1')).to.be.false;
  });
});

describe('dates', () => {
  it('toEpochMs and isValidDate accept Dates from another realm', () => {
    const foreign = otherRealm<Date>('new Date(1000)');
    expect(foreign instanceof Date).to.be.false;
    expect(toEpochMs(foreign)).to.equal(1000);
    expect(isValidDate(foreign)).to.be.true;
    expect(toEpochMs(new Date(NaN))).to.be.undefined;
    expect(isValidDate(new Date(NaN))).to.be.false;
    expect(toEpochMs(1000)).to.be.undefined;
    expect(toEpochMs({ getTime: () => 1 })).to.be.undefined;
  });

  it('toEpochMs ignores an overridden getTime', () => {
    const d = new Date(5);
    (d as unknown as { getTime: () => number }).getTime = () => 99;
    expect(toEpochMs(d)).to.equal(5);
  });

  it('parseIsoInstant reads zoned instants', () => {
    expect(parseIsoInstant('2030-01-02T03:04:05Z')?.toISOString()).to.equal('2030-01-02T03:04:05.000Z');
    expect(parseIsoInstant('2030-01-02T03:04Z')?.toISOString()).to.equal('2030-01-02T03:04:00.000Z');
    expect(parseIsoInstant('2030-01-02T03:04:05.678+01:30')?.toISOString()).to.equal('2030-01-02T01:34:05.678Z');
    expect(parseIsoInstant('2030-01-02T03:04:05.1Z')?.toISOString()).to.equal('2030-01-02T03:04:05.100Z');
    expect(parseIsoInstant('2030-01-02T03:04:05.123456789Z')?.toISOString()).to.equal('2030-01-02T03:04:05.123Z');
    expect(parseIsoInstant('2028-02-29T00:00:00Z')?.toISOString()).to.equal('2028-02-29T00:00:00.000Z');
    expect(parseIsoInstant('0050-01-01T00:00:00Z')?.getUTCFullYear()).to.equal(50);
  });

  it('parseIsoInstant refuses roll-over, missing zones and other forms', () => {
    for (const text of [
      '2026-02-29T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T23:60:00Z',
      '2026-01-01T23:59:60Z',
      '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00+01:60',
      '2026-01-01T00:00:00',
      '2026-01-01t00:00:00z',
      '2026-01-01',
      'Thu, 01 Jan 2026 00:00:00 GMT',
      '1767225600000',
      ' 2026-01-01T00:00:00Z',
      '',
    ]) {
      expect(parseIsoInstant(text), text).to.be.undefined;
    }
    expect(parseIsoInstant(123)).to.be.undefined;
  });

  it('parseIsoInstant reads a bare date only when asked', () => {
    expect(parseIsoInstant('2030-01-02', { dateOnly: true })?.toISOString()).to.equal('2030-01-02T00:00:00.000Z');
    expect(parseIsoInstant('2026-02-30', { dateOnly: true })).to.be.undefined;
  });
});

describe('maybe-async helpers', () => {
  it('thenMaybe stays synchronous for a plain value', () => {
    expect(thenMaybe(2, (n) => n * 2)).to.equal(4);
  });

  it('thenMaybe waits for a promise or a thenable', async () => {
    const p = thenMaybe(Promise.resolve(2), (n) => n * 2);
    expect(p).to.be.instanceOf(Promise);
    expect(await p).to.equal(4);
    const thenable: PromiseLike<number> = { then: (ok) => Promise.resolve(ok?.(3)) as never };
    expect(await thenMaybe(thenable, (n) => n + 1)).to.equal(4);
  });

  it('allMaybe returns values synchronously when none is a promise', async () => {
    const sync = allMaybe([1, 'a'] as const);
    expect(sync).to.deep.equal([1, 'a']);
    const later = allMaybe([1, Promise.resolve('b')]);
    expect(later).to.be.instanceOf(Promise);
    expect(await later).to.deep.equal([1, 'b']);
  });

  it('allMaybe passes a rejection through', async () => {
    const failed = allMaybe([1, Promise.reject(new Error('boom'))]) as Promise<unknown>;
    let message = '';
    await failed.catch((e: Error) => (message = e.message));
    expect(message).to.equal('boom');
  });
});

describe('object helpers ( data )', () => {
  it('isStrictPlainObject accepts only Object.prototype or null prototypes', () => {
    expect(isStrictPlainObject({})).to.be.true;
    expect(isStrictPlainObject(Object.create(null))).to.be.true;
    expect(isStrictPlainObject([])).to.be.false;
    expect(isStrictPlainObject(new (class X {})())).to.be.false;
    expect(isStrictPlainObject(new Date())).to.be.false;
    expect(isStrictPlainObject(null)).to.be.false;
    expect(isStrictPlainObject('x')).to.be.false;
  });

  it('UNSAFE_KEYS and isUnsafeKey', () => {
    expect([...UNSAFE_KEYS].sort()).to.deep.equal(['__proto__', 'constructor', 'prototype']);
    expect(isUnsafeKey('__proto__')).to.be.true;
    expect(isUnsafeKey('name')).to.be.false;
    expect(isUnsafeKey(Symbol('__proto__'))).to.be.false;
  });

  it('defineOwn makes __proto__ an own key instead of changing the prototype', () => {
    const o: Record<string, unknown> = {};
    defineOwn(o, '__proto__', { polluted: true });
    expect(Object.getPrototypeOf(o)).to.equal(Object.prototype);
    expect(Object.keys(o)).to.deep.equal(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).to.be.undefined;
  });

  it('getOwnPath reads own properties and refuses unsafe segments', () => {
    const data = { a: { b: [10, 20] }, 'x.y': 1 };
    expect(getOwnPath(data, 'a.b.1')).to.equal(20);
    expect(getOwnPath(data, ['x.y'])).to.equal(1);
    expect(getOwnPath(data, 'a.c')).to.be.undefined;
    expect(getOwnPath(data, 'a.b.length')).to.equal(2);
    expect(getOwnPath(data, 'toString')).to.be.undefined;
    expect(getOwnPath(data, 'constructor.name')).to.be.undefined;
    expect(getOwnPath(JSON.parse('{"__proto__":{"x":1}}'), '__proto__.x')).to.be.undefined;
    expect(getOwnPath('abc', 'length')).to.be.undefined;
  });

  it('deepFreeze with skipDates leaves Dates unfrozen', () => {
    const v = deepFreeze({ at: new Date(0), list: [{ n: 1 }] }, { skipDates: true });
    expect(Object.isFrozen(v)).to.be.true;
    expect(Object.isFrozen(v.list[0])).to.be.true;
    expect(Object.isFrozen(v.at)).to.be.false;
    const all = deepFreeze({ at: new Date(0) });
    expect(Object.isFrozen(all.at)).to.be.true;
  });
});

describe('copyPlainData', () => {
  it('copies plain data deeply', () => {
    const src = { a: [1, { b: 'x' }], at: new Date(5), n: null, u: undefined, proto: Object.assign(Object.create(null), { k: 1 }) };
    const copy = copyPlainData(src);
    expect(copy).to.deep.equal({ a: [1, { b: 'x' }], at: new Date(5), n: null, u: undefined, proto: { k: 1 } });
    expect(copy.a).to.not.equal(src.a);
    expect(copy.at).to.not.equal(src.at);
    expect(Object.getPrototypeOf(copy.proto)).to.equal(Object.prototype);
  });

  it('copies a Date from another realm into a local Date', () => {
    const copy = copyPlainData({ at: otherRealm<Date>('new Date(7)') });
    expect(copy.at).to.be.instanceOf(Date);
    expect(copy.at.getTime()).to.equal(7);
  });

  it('drops unsafe keys', () => {
    const copy = copyPlainData(JSON.parse('{"__proto__":{"x":1},"ok":1}')) as Record<string, unknown>;
    expect(Object.keys(copy)).to.deep.equal(['ok']);
  });

  it('keeps shared subtrees and refuses cycles', () => {
    const shared = { x: 1 };
    expect(copyPlainData({ a: shared, b: shared })).to.deep.equal({ a: { x: 1 }, b: { x: 1 } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => copyPlainData(cyclic)).to.throw(TypeError, /cycle/);
  });

  it('refuses values that are not plain data', () => {
    expect(() => copyPlainData({ m: new Map() })).to.throw(TypeError);
    expect(() => copyPlainData({ c: new (class X {})() })).to.throw(TypeError);
    expect(() => copyPlainData({ f: () => 1 })).to.throw(TypeError);
    expect(() => copyPlainData([Symbol('s')])).to.throw(TypeError);
    const fakeMap = new Map();
    Object.setPrototypeOf(fakeMap, Object.prototype);
    expect(() => copyPlainData(fakeMap)).to.throw(TypeError);
  });

  it('enforces maxDepth and maxValues', () => {
    expect(copyPlainData({ a: { b: 1 } }, { maxDepth: 1 })).to.deep.equal({ a: { b: 1 } });
    expect(() => copyPlainData({ a: { b: { c: 1 } } }, { maxDepth: 1 })).to.throw(RangeError);
    expect(copyPlainData([1, 2, 3], { maxValues: 3 })).to.deep.equal([1, 2, 3]);
    expect(() => copyPlainData([1, 2, 3, 4], { maxValues: 3 })).to.throw(RangeError);
    const shared = [1, 2, 3];
    expect(() => copyPlainData({ a: shared, b: shared }, { maxValues: 7 })).to.throw(RangeError);
  });
});

describe('deepEqual', () => {
  it('compares plain data structurally', () => {
    expect(deepEqual({ a: [1, { b: 'x' }], d: new Date(1) }, { a: [1, { b: 'x' }], d: new Date(1) })).to.be.true;
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).to.be.true;
    expect(deepEqual({ a: 1 }, { a: 2 })).to.be.false;
    expect(deepEqual([1, 2], [2, 1])).to.be.false;
    expect(deepEqual(NaN, NaN)).to.be.true;
    expect(deepEqual(0, -0)).to.be.false;
    expect(deepEqual(new Date(1), new Date(2))).to.be.false;
    expect(deepEqual(Object.create(null), {})).to.be.false;
  });

  it('treats a missing key and an undefined value as different', () => {
    expect(deepEqual({ x: undefined }, {})).to.be.false;
    expect(deepEqual({}, { x: undefined })).to.be.false;
  });

  it('compares holes, extra array keys, symbols and accessors as different', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(deepEqual([1, , 3], [1, undefined, 3])).to.be.false;
    const extra = Object.assign([1], { x: 1 });
    expect(deepEqual(extra, [1])).to.be.false;
    expect(deepEqual({ [Symbol('s')]: 1 }, { [Symbol('s')]: 1 })).to.be.false;
    let ran = false;
    const getter = {
      get a() {
        ran = true;
        return 1;
      },
    };
    expect(deepEqual(getter, { a: 1 })).to.be.false;
    expect(ran).to.be.false;
  });

  it('compares objects with internal slots by reference only', () => {
    const m = new Map([[1, 2]]);
    expect(deepEqual(m, m)).to.be.true;
    expect(deepEqual(new Map([[1, 2]]), new Map([[1, 2]]))).to.be.false;
    expect(deepEqual(new Set(), new Set())).to.be.false;
    expect(deepEqual(new Uint8Array([1]), new Uint8Array([1]))).to.be.false;
    class P {
      constructor(public x: number) {}
    }
    expect(deepEqual(new P(1), new P(1))).to.be.false;
    const a = new Map();
    const b = new Map();
    Object.setPrototypeOf(a, Object.prototype);
    Object.setPrototypeOf(b, Object.prototype);
    expect(deepEqual(a, b)).to.be.false;
  });

  it('answers false past maxWork or maxDepth, and on a cycle', () => {
    const wide = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(deepEqual(wide(50), wide(50))).to.be.true;
    expect(deepEqual(wide(50), wide(50), { maxWork: 20 })).to.be.false;
    const deep = (n: number): unknown => (n === 0 ? 1 : { n: deep(n - 1) });
    expect(deepEqual(deep(5), deep(5), { maxDepth: 10 })).to.be.true;
    expect(deepEqual(deep(20), deep(20), { maxDepth: 10 })).to.be.false;
    const x: Record<string, unknown> = {};
    x.self = x;
    const y: Record<string, unknown> = {};
    y.self = y;
    expect(deepEqual(x, y)).to.be.false;
  });
});

describe('deepMerge', () => {
  it('merges plain objects recursively without changing the inputs', () => {
    const base = { db: { host: 'a', port: 1, opts: { ssl: false } }, list: [1] };
    const over = { db: { port: 2, opts: { ssl: true } }, list: [2], extra: 'x' };
    const out = deepMerge(base, over);
    expect(out).to.deep.equal({ db: { host: 'a', port: 2, opts: { ssl: true } }, list: [2], extra: 'x' });
    expect(base.db.port).to.equal(1);
    expect(out.db).to.not.equal(base.db);
    expect(out.list).to.not.equal(over.list);
  });

  it('concatenates arrays when asked', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [2, 3] }, { arrays: 'concat' })).to.deep.equal({ a: [1, 2, 2, 3] });
  });

  it('keeps the base value for undefined, replaces for null', () => {
    expect(deepMerge({ a: 1, b: 1 }, { a: undefined, b: null, c: undefined })).to.deep.equal({ a: 1, b: null });
  });

  it('replaces non-plain values by reference and drops unsafe keys', () => {
    const at = new Date(0);
    const out = deepMerge({ at: new Date(1), m: { x: 1 } }, { at, m: new Map() }) as Record<string, unknown>;
    expect(out.at).to.equal(at);
    expect(out.m).to.be.instanceOf(Map);
    const polluted = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}') as object);
    expect(Object.keys(polluted)).to.deep.equal([]);
    expect(({} as Record<string, unknown>).polluted).to.be.undefined;
  });

  it('allows the same subtree on both sides and refuses cycles', () => {
    const shared = { x: { y: 1 } };
    expect(deepMerge({ a: shared }, { a: shared, b: shared })).to.deep.equal({ a: { x: { y: 1 } }, b: { x: { y: 1 } } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => deepMerge({}, cyclic)).to.throw(TypeError, /cycle/);
    expect(() => deepMerge([] as unknown as object, {})).to.throw(TypeError);
  });
});

describe('JSON helpers', () => {
  it('replacer and reviver round-trip Dates, also inside Maps', () => {
    const src = { at: new Date(5), bad: new Date(NaN), m: new Map([['k', new Date(6)]]), s: 'plain' };
    const text = jsonStringify(src);
    expect(JSON.parse(text).at).to.deep.equal({ dataType: 'Date', value: '1970-01-01T00:00:00.005Z' });
    const back = jsonParse<{ at: Date; bad: Date; m: Map<string, Date>; s: string }>(text);
    expect(back.at).to.be.instanceOf(Date);
    expect(back.at.getTime()).to.equal(5);
    expect(Number.isNaN(back.bad.getTime())).to.be.true;
    expect(back.m.get('k')?.getTime()).to.equal(6);
    expect(back.s).to.equal('plain');
  });

  it('replacer called without a holder still tags Map and Set', () => {
    expect(replacer('', new Set([1]))).to.deep.equal({ dataType: 'Set', value: [1] });
    expect(replacer('', '2020-01-01T00:00:00.000Z')).to.equal('2020-01-01T00:00:00.000Z');
    expect(reviver('', { dataType: 'Date', value: '2020-01-01T00:00:00.000Z' })).to.be.instanceOf(Date);
  });

  it('stableStringify sorts keys and matches JSON.stringify otherwise', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).to.equal('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(stableStringify({ b: 1, a: 2 })).to.equal(stableStringify({ a: 2, b: 1 }));
    const value = { u: undefined, f: () => 1, list: [undefined, () => 1, NaN, Infinity], at: new Date(0), s: 'x"y', n: null, boxed: new Number(1) };
    expect(stableStringify(value)).to.equal(JSON.stringify({ at: value.at, boxed: 1, list: value.list, n: null, s: 'x"y' }));
    expect(stableStringify({ toJSON: (k: string) => `key:${k}` })).to.equal('"key:"');
    expect(stableStringify(undefined)).to.equal('null');
    expect(stableStringify('a')).to.equal('"a"');
  });

  it('stableStringify sorts by code unit and throws on cycles and bigints', () => {
    expect(stableStringify({ '｡': 1, '\u{1F600}': 2 })).to.equal('{"\u{1F600}":2,"｡":1}');
    const shared = { x: 1 };
    expect(stableStringify([shared, shared])).to.equal('[{"x":1},{"x":1}]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).to.throw(TypeError);
    expect(() => stableStringify({ n: 1n })).to.throw(TypeError);
  });
});

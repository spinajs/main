import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import {
  // array
  toArray,
  chunk,
  unique,
  uniqueBy,
  groupBy,
  // hash
  tryGetHash,
  tryGetHashSync,
  getOrInsert,
  // json
  replacer,
  reviver,
  jsonStringify,
  jsonParse,
  safeParse,
  // string
  trimChar,
  capitalize,
  capitalizeWords,
  truncate,
  truncateWords,
  isNullOrWhitespace,
  // func
  Lazy,
  noop,
  identity,
  once,
  memoize,
  // types
  isPromise,
  isDefined,
  isFunction,
} from '../src/index.js';

chai.use(chaiAsPromised);

describe('helpers', () => {
  describe('array', () => {
    it('toArray wraps / passes through / handles nil', () => {
      expect(toArray(1)).to.deep.eq([1]);
      expect(toArray([1, 2])).to.deep.eq([1, 2]);
      expect(toArray(null as any)).to.deep.eq([]);
      expect(toArray(undefined as any)).to.deep.eq([]);
    });

    it('chunk splits into groups of size', () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).to.deep.eq([[1, 2], [3, 4], [5]]);
      expect(chunk([], 3)).to.deep.eq([]);
      expect(chunk([1], 3)).to.deep.eq([[1]]);
    });

    it('chunk rejects size < 1', () => {
      expect(() => chunk([1, 2], 0)).to.throw();
    });

    it('unique removes duplicates preserving order', () => {
      expect(unique([1, 1, 2, 3, 2])).to.deep.eq([1, 2, 3]);
      expect(unique(['a', 'a', 'b'])).to.deep.eq(['a', 'b']);
    });

    it('uniqueBy dedupes by derived key, first-seen wins', () => {
      const out = uniqueBy([{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }], (o) => o.id);
      expect(out).to.deep.eq([{ id: 1, v: 'a' }, { id: 2, v: 'c' }]);
      expect(uniqueBy([], (x: number) => x)).to.deep.eq([]);
    });

    it('groupBy buckets by key', () => {
      const g = groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even'));
      expect(g.get('odd')).to.deep.eq([1, 3]);
      expect(g.get('even')).to.deep.eq([2, 4]);
    });

    it('groupBy exposes the index', () => {
      const g = groupBy(['a', 'b', 'c'], (_v, i) => i % 2);
      expect(g.get(0)).to.deep.eq(['a', 'c']);
      expect(g.get(1)).to.deep.eq(['b']);
    });
  });

  describe('hash', () => {
    it('tryGetHash returns existing and computes missing (async)', async () => {
      const m = new Map<string, number>([['a', 1]]);
      expect(await tryGetHash(m, 'a', async () => 99)).to.eq(1);
      expect(await tryGetHash(m, 'b', async () => 2)).to.eq(2);
      expect(m.get('b')).to.eq(2);
    });

    it('tryGetHash calls onMissing only once per key', async () => {
      const m = new Map<string, number>();
      let calls = 0;
      await tryGetHash(m, 'x', async () => (++calls, 1));
      await tryGetHash(m, 'x', async () => (++calls, 1));
      expect(calls).to.eq(1);
    });

    it('tryGetHashSync computes + stores missing', () => {
      const m = new Map<string, number>();
      expect(tryGetHashSync(m, 'a', () => 5)).to.eq(5);
      expect(m.get('a')).to.eq(5);
      // second call returns cached, factory not used
      expect(tryGetHashSync(m, 'a', () => 999)).to.eq(5);
    });

    it('getOrInsert aliases tryGetHashSync', () => {
      const m = new Map<string, number>();
      expect(getOrInsert(m, 'k', () => 7)).to.eq(7);
      expect(getOrInsert(m, 'k', () => 8)).to.eq(7);
    });
  });

  describe('json', () => {
    it('round-trips Map via replacer/reviver', () => {
      const src = { m: new Map([['a', 1], ['b', 2]]) };
      const json = JSON.stringify(src, replacer);
      const back = JSON.parse(json, reviver) as typeof src;
      expect(back.m).to.be.instanceOf(Map);
      expect(back.m.get('a')).to.eq(1);
    });

    it('round-trips Set via jsonStringify/jsonParse', () => {
      const src = { tags: new Set(['x', 'y']) };
      const back = jsonParse<typeof src>(jsonStringify(src));
      expect(back.tags).to.be.instanceOf(Set);
      expect([...back.tags]).to.deep.eq(['x', 'y']);
    });

    it('jsonStringify honors indentation', () => {
      expect(jsonStringify({ a: 1 }, 2)).to.contain('\n');
    });

    it('safeParse returns fallback on malformed / non-string', () => {
      expect(safeParse('not json', 42)).to.eq(42);
      expect(safeParse('[1,2]', [])).to.deep.eq([1, 2]);
      expect(safeParse(undefined as any, 'fb')).to.eq('fb');
    });
  });

  describe('string', () => {
    it('trimChar trims a repeated char from both ends', () => {
      expect(trimChar('__x__', '_')).to.eq('x');
      expect(trimChar('abc', '_')).to.eq('abc');
    });

    it('capitalize upper-cases the first char only', () => {
      expect(capitalize('hello')).to.eq('Hello');
      expect(capitalize('')).to.eq('');
      expect(capitalize('aBC')).to.eq('ABC');
    });

    it('capitalizeWords capitalizes each word, preserving spacing', () => {
      expect(capitalizeWords('hello brave world')).to.eq('Hello Brave World');
      expect(capitalizeWords('  spaced   out ')).to.eq('  Spaced   Out ');
      expect(capitalizeWords('')).to.eq('');
    });

    it('truncateWords keeps at most N words', () => {
      expect(truncateWords('the quick brown fox jumps', 3)).to.eq('the quick brown…');
      expect(truncateWords('one two', 5)).to.eq('one two');
      expect(truncateWords('a b c', 2, '...')).to.eq('a b...');
    });

    it('truncate shortens and appends suffix', () => {
      expect(truncate('the quick brown fox', 9)).to.eq('the quic…');
      expect(truncate('short', 10)).to.eq('short');
      expect(truncate('abc', 2, '...')).to.eq('..');
    });

    it('isNullOrWhitespace detects blank values', () => {
      expect(isNullOrWhitespace('   ')).to.be.true;
      expect(isNullOrWhitespace('')).to.be.true;
      expect(isNullOrWhitespace(null)).to.be.true;
      expect(isNullOrWhitespace(undefined)).to.be.true;
      expect(isNullOrWhitespace('x')).to.be.false;
    });
  });

  describe('func', () => {
    it('Lazy delays execution until call', () => {
      let ran = false;
      const l = Lazy.oF(() => {
        ran = true;
        return 5;
      });
      expect(ran).to.be.false;
      expect(l.call(null)).to.eq(5);
      expect(ran).to.be.true;
    });

    it('noop returns undefined, identity returns its input', () => {
      expect(noop()).to.eq(undefined);
      expect(identity(7)).to.eq(7);
      const o = {};
      expect(identity(o)).to.eq(o);
    });

    it('once runs the fn a single time', () => {
      let calls = 0;
      const init = once(() => ++calls);
      expect(init()).to.eq(1);
      expect(init()).to.eq(1);
      expect(calls).to.eq(1);
    });

    it('memoize caches by argument (default key)', () => {
      let calls = 0;
      const square = memoize((n: number) => {
        calls++;
        return n * n;
      });
      expect(square(3)).to.eq(9);
      expect(square(3)).to.eq(9);
      expect(square(4)).to.eq(16);
      expect(calls).to.eq(2);
    });

    it('memoize supports a custom key function', () => {
      let calls = 0;
      const byId = memoize(
        (o: { id: number; v: number }) => {
          calls++;
          return o.v;
        },
        (o) => o.id,
      );
      expect(byId({ id: 1, v: 10 })).to.eq(10);
      expect(byId({ id: 1, v: 99 })).to.eq(10); // same id -> cached
      expect(calls).to.eq(1);
    });
  });

  describe('types', () => {
    it('isPromise', () => {
      expect(isPromise(Promise.resolve())).to.be.true;
      expect(isPromise(42)).to.be.false;
      expect(isPromise({ then: () => 0 })).to.be.false; // only native promises
    });

    it('isDefined narrows away nil', () => {
      expect(isDefined(0)).to.be.true;
      expect(isDefined('')).to.be.true;
      expect(isDefined(null)).to.be.false;
      expect(isDefined(undefined)).to.be.false;
    });

    it('isFunction', () => {
      expect(isFunction(() => 0)).to.be.true;
      expect(isFunction(class {})).to.be.true;
      expect(isFunction(42)).to.be.false;
    });
  });
});

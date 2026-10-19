import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { BoundedMap, LruTtlCache, LruTtlEvictReason, ManualClock, memoizeAsync } from '../src/index.js';

describe('LruTtlCache', () => {
  const make = (maxEntries = 3, extra: { ttlMs?: number; expireOnClockRewind?: boolean } = {}) => {
    const clock = new ManualClock(new Date(1_000_000));
    const evicted: [string, number, LruTtlEvictReason][] = [];
    const cache = new LruTtlCache<string, number>({ maxEntries, clock, onEvict: (k, v, r) => evicted.push([k, v, r]), ...extra });
    return { cache, clock, evicted };
  };

  it('rejects an invalid maxEntries', () => {
    expect(() => new LruTtlCache({ maxEntries: -1 })).to.throw(InvalidArgument);
    expect(() => new LruTtlCache({ maxEntries: 1.5 })).to.throw(InvalidArgument);
  });

  it('expires an entry after its TTL', () => {
    const { cache, clock, evicted } = make();
    cache.set('a', 1, { ttlMs: 100 });
    clock.advance(99);
    expect(cache.get('a')).to.eq(1);
    clock.advance(1);
    expect(cache.has('a')).to.be.false;
    expect(cache.get('a')).to.be.undefined;
    expect(evicted).to.deep.eq([['a', 1, 'expired']]);
    expect(cache.size).to.eq(0);
  });

  it('uses the cache TTL when a set gives none, and no expiry when neither does', () => {
    const withTtl = make(3, { ttlMs: 10 });
    withTtl.cache.set('a', 1);
    withTtl.clock.advance(10);
    expect(withTtl.cache.get('a')).to.be.undefined;

    const forever = make();
    forever.cache.set('a', 1);
    forever.clock.advance(1e12);
    expect(forever.cache.get('a')).to.eq(1);
  });

  it('does not store an entry with a TTL that is not a finite number above 0, and drops the old one', () => {
    const { cache, evicted } = make();
    cache.set('a', 1);
    for (const ttlMs of [0, -1, NaN, Infinity]) cache.set('a', 2, { ttlMs });
    expect(cache.get('a')).to.be.undefined;
    expect(evicted).to.deep.eq([['a', 1, 'replaced']]);
  });

  it('does not store an entry when the clock gives an invalid date', () => {
    const cache = new LruTtlCache<string, number>({ maxEntries: 2, clock: { now: () => new Date(NaN) } });
    cache.set('a', 1, { ttlMs: 10 });
    expect(cache.size).to.eq(0);
  });

  it('evicts the least recently used entry first', () => {
    const { cache, evicted } = make(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.peek('b')).to.be.undefined;
    expect(cache.peek('a')).to.eq(1);
    expect(cache.peek('c')).to.eq(3);
    expect(evicted).to.deep.eq([['b', 2, 'capacity']]);
  });

  it('peek does not change the recency order', () => {
    const { cache } = make(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.peek('a');
    cache.set('c', 3);
    expect(cache.has('a')).to.be.false;
  });

  it('maxEntries 0 holds nothing', () => {
    const { cache, evicted } = make(0);
    cache.set('a', 1);
    expect(cache.size).to.eq(0);
    expect(evicted).to.deep.eq([]);
  });

  it('invalidates by tag', () => {
    const { cache, evicted } = make(5);
    cache.set('a', 1, { tags: ['t1', 't2'] });
    cache.set('b', 2, { tags: ['t2'] });
    cache.set('c', 3, { tags: ['t3'] });
    cache.invalidate(['t2', 'unknown']);
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).to.deep.eq([false, false, true]);
    expect(evicted.map((e) => e[2])).to.deep.eq(['invalidated', 'invalidated']);
    cache.invalidate(['t1']);
    expect(cache.size).to.eq(1);
  });

  it('a replaced entry loses its old tags', () => {
    const { cache } = make();
    cache.set('a', 1, { tags: ['old'] });
    cache.set('a', 2, { tags: ['new'] });
    cache.invalidate(['old']);
    expect(cache.get('a')).to.eq(2);
  });

  it('delete and clear report their reasons', () => {
    const { cache, evicted } = make();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).to.be.true;
    expect(cache.delete('a')).to.be.false;
    cache.clear();
    expect(evicted).to.deep.eq([
      ['a', 1, 'deleted'],
      ['b', 2, 'cleared'],
    ]);
  });

  it('keeps an entry from a later clock time unless expireOnClockRewind is set', () => {
    const kept = make();
    kept.cache.set('a', 1, { ttlMs: 100 });
    kept.clock.advance(-50);
    expect(kept.cache.get('a')).to.eq(1);

    const dropped = make(3, { expireOnClockRewind: true });
    dropped.cache.set('a', 1, { ttlMs: 100 });
    dropped.clock.advance(-1);
    expect(dropped.cache.peek('a')).to.be.undefined;
    expect(dropped.cache.get('a')).to.be.undefined;
  });

  it('works as the map of memoizeAsync', async () => {
    const cache = new LruTtlCache<string, Promise<number>>({ maxEntries: 2 });
    expect(await memoizeAsync(cache, 'k', async () => 5)).to.eq(5);
    expect(await memoizeAsync(cache, 'k', async () => 6)).to.eq(5);
  });
});

describe('BoundedMap', () => {
  it('rejects an invalid max', () => {
    expect(() => new BoundedMap(0)).to.throw(InvalidArgument);
    expect(() => new BoundedMap(2.5)).to.throw(InvalidArgument);
  });

  it('drops the oldest key when a new key comes in full', () => {
    const map = new BoundedMap<string, number>(2);
    map.set('a', 1).set('b', 2);
    map.get('a');
    map.set('c', 3);
    expect(map.has('a')).to.be.false;
    expect(map.get('b')).to.eq(2);
    expect(map.get('c')).to.eq(3);
    expect(map.size).to.eq(2);
  });

  it('setting a held key keeps its place and drops nothing', () => {
    const map = new BoundedMap<string, number>(2);
    map.set('a', 1).set('b', 2).set('a', 10);
    expect(map.size).to.eq(2);
    map.set('c', 3);
    expect(map.has('a')).to.be.false;
    expect(map.get('b')).to.eq(2);
  });

  it('delete and clear', () => {
    const map = new BoundedMap<string, number>(2);
    map.set('a', 1).set('b', 2);
    expect(map.delete('a')).to.be.true;
    map.clear();
    expect(map.size).to.eq(0);
  });
});

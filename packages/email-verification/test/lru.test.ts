import { expect } from 'chai';
import { LruCache } from '../src/lru.js';

describe('LruCache', () => {
  it('evicts the least recently used entry beyond maxEntries', () => {
    const lru = new LruCache<number>(2);
    lru.set('a', 1, 1000);
    lru.set('b', 2, 1000);
    lru.get('a');
    lru.set('c', 3, 1000);
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).to.deep.eq([1, undefined, 3]);
  });

  it('expires an entry after its TTL', () => {
    let now = 0;
    const lru = new LruCache<number>(10, () => now);
    lru.set('a', 1, 100);
    now = 99;
    expect(lru.get('a')).to.eq(1);
    now = 100;
    expect(lru.get('a')).to.eq(undefined);
    expect(lru.size).to.eq(0);
  });

  it('stores nothing for a TTL of 0 or a size of 0', () => {
    const lru = new LruCache<number>(10);
    lru.set('a', 1, 0);
    expect(lru.get('a')).to.eq(undefined);
    const none = new LruCache<number>(0);
    none.set('a', 1, 1000);
    expect(none.size).to.eq(0);
  });
});

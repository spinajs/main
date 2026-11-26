import { expect } from 'chai';
import 'mocha';
import { ManualClock } from '@spinajs/util';
import { MemoryCacheStore } from '../src/index.js';
import type { CacheEntry, CacheSettings, TagBump } from '../src/index.js';

const HOUR = 3_600_000;

function setup(options: { maxEntries?: number; maxBytes?: number; maxTtlMs?: number; maxTags?: number } = {}) {
  const clock = new ManualClock(new Date(1_000_000));
  const store = new MemoryCacheStore({ maxTtlMs: HOUR, ...options, clock });
  const entry = (tags: string[], extra: Partial<CacheEntry> = {}): CacheEntry => ({
    value: new Uint8Array([1, 2, 3]),
    tags,
    versions: store.versionsNow(tags),
    storedAt: clock.now().getTime(),
    ttlMs: 1000,
    swrMs: 0,
    ...extra,
  });
  return { clock, store, entry };
}

const bump = (...tags: string[]): TagBump[] => tags.map((tag) => ({ tag, version: `stamp.${tag}` }));

describe('MemoryCacheStore', () => {
  it('reads an entry as valid while none of its tags was bumped', async () => {
    const { store, entry } = setup();
    await store.set('k', entry(['a', 'b']));
    const read = await store.get('k');
    expect(read?.valid).to.eq(true);
    expect([...(read?.entry.value ?? [])]).to.deep.eq([1, 2, 3]);
    expect(await store.get('other')).to.eq(undefined);
  });

  it('reads an entry as invalid once one of its tags was bumped, and drops it', async () => {
    const { store, entry } = setup();
    await store.set('k', entry(['a', 'b']));
    await store.set('j', entry(['c']));
    await store.bump(bump('b'));
    expect((await store.get('k'))?.valid).to.eq(false);
    expect(await store.get('k')).to.eq(undefined);
    expect((await store.get('j'))?.valid).to.eq(true);
  });

  it('keeps a value computed before a bump invalid, also when the bump is applied again', async () => {
    const { store, entry } = setup();
    const before = entry(['a']);
    await store.bump(bump('a'));
    await store.set('k', before);
    expect((await store.get('k'))?.valid).to.eq(false);
    const between = entry(['a']);
    await store.bump(bump('a'));
    await store.set('j', between);
    expect((await store.get('j'))?.valid).to.eq(false);
    await store.set('i', entry(['a']));
    expect((await store.get('i'))?.valid).to.eq(true);
  });

  it('never hands out a version twice, also not across two stores', async () => {
    const { store } = setup();
    const seen = new Set<string>(store.versionsNow(['a']));
    for (let i = 0; i < 5; i += 1) {
      await store.bump(bump('a'));
      const [version] = store.versionsNow(['a']);
      expect(seen.has(version)).to.eq(false);
      seen.add(version);
    }
    expect(seen.has(new MemoryCacheStore().versionsNow(['a'])[0])).to.eq(false);
    for (const version of seen) expect(version).to.match(/^[^|]+$/);
  });

  it('expires an entry after ttl plus swr, capped by maxTtl', async () => {
    const { store, entry, clock } = setup({ maxTtlMs: 5000 });
    await store.set('k', entry([], { ttlMs: 1000, swrMs: 1000 }));
    await store.set('long', entry([], { ttlMs: 4000, swrMs: 4000 }));
    clock.advance(1999);
    expect(await store.get('k')).to.not.eq(undefined);
    clock.advance(1);
    expect(await store.get('k')).to.eq(undefined);
    clock.advance(2999);
    expect(await store.get('long')).to.not.eq(undefined);
    clock.advance(1);
    expect(await store.get('long')).to.eq(undefined);
  });

  it('evicts the least recently used entries beyond maxBytes or maxEntries', async () => {
    // A one-letter key and three bytes weigh 3 + 1 * 2 = 5.
    const bytes = setup({ maxEntries: 10, maxBytes: 10 });
    await bytes.store.set('a', bytes.entry([]));
    await bytes.store.set('b', bytes.entry([]));
    await bytes.store.get('a');
    await bytes.store.set('c', bytes.entry([]));
    expect(await bytes.store.get('b')).to.eq(undefined);
    expect(await bytes.store.get('a')).to.not.eq(undefined);
    expect(await bytes.store.get('c')).to.not.eq(undefined);
    const count = setup({ maxEntries: 1 });
    await count.store.set('a', count.entry([]));
    await count.store.set('b', count.entry([]));
    expect(await count.store.get('a')).to.eq(undefined);
  });

  it('reads an entry whose versions do not pair up with its tags as invalid', async () => {
    const { store, entry } = setup();
    await store.set('fewer', entry(['x'], { versions: [] }));
    await store.set('more', entry(['a'], { versions: [...store.versionsNow(['a']), 'extra'] }));
    expect((await store.get('fewer'))?.valid).to.eq(false);
    expect((await store.get('more'))?.valid).to.eq(false);
  });

  // A store that answers a fixed version (such as '0') for a tag it holds none for fails this.
  it('reads an entry as invalid once the store dropped a version it holds, and gives the tag a new one', async () => {
    const { store, entry } = setup({ maxTags: 1 });
    const kept = entry(['a']);
    await store.set('k', kept);
    // A second tag pushes 'a' out of a store that keeps one version.
    store.versionsNow(['b']);
    expect((await store.get('k'))?.valid).to.eq(false);
    expect(store.versionsNow(['a'])).to.not.deep.eq(kept.versions);
  });

  it('forgets a version maxTtl after it was last handed out or bumped, and never answers it again', async () => {
    const { store, clock } = setup({ maxTtlMs: 1000 });
    await store.bump(bump('a'));
    const [bumped] = store.versionsNow(['a']);
    clock.advance(999);
    store.versionsNow(['a']);
    clock.advance(500);
    // Counted from the bump, 'a' would be gone by now; it was handed out 500 ms ago.
    await store.bump(bump('b'));
    expect(store.versionsNow(['a'])).to.deep.eq([bumped]);
    clock.advance(1000);
    await store.bump(bump('b'));
    expect(store.versionsNow(['a'])).to.not.deep.eq([bumped]);
  });

  it('takes its bounds from the settings of its cache', async () => {
    const store = new MemoryCacheStore();
    const settings: CacheSettings = { name: 'default', store: 'MemoryCacheStore', maxEntries: 1, maxBytes: 1000, maxTtlMs: 1000, consistency: 'eventual', breakerFailures: 5, breakerResetMs: 10_000, raw: {} };
    await store.configure(settings);
    const entry = (): CacheEntry => ({ value: new Uint8Array([1]), tags: [], versions: [], storedAt: Date.now(), ttlMs: 500, swrMs: 0 });
    await store.set('a', entry());
    await store.set('b', entry());
    expect(await store.get('a')).to.eq(undefined);
    expect((await store.get('b'))?.valid).to.eq(true);
  });

  it('keeps a maxTags given to the constructor when configured', async () => {
    const { store, entry } = setup({ maxTags: 1 });
    await store.configure({ name: 'default', store: 'MemoryCacheStore', maxEntries: 10, maxBytes: 1000, maxTtlMs: HOUR, consistency: 'eventual', breakerFailures: 5, breakerResetMs: 10_000, raw: {} });
    await store.set('k', entry(['a']));
    store.versionsNow(['b']);
    expect((await store.get('k'))?.valid).to.eq(false);
  });
});

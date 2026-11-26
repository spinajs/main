import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { Breaker, CacheConfigError, CacheScope, MemoryCacheStore, TieredCacheStore, cache } from '../src/index.js';
import type { CacheEntry, CacheStoreRead, CacheStoreReadOptions, TagBump } from '../src/index.js';
import { SharedTier, drain, startProcess, wire } from './support/processes.js';

/** Two replicas, each with its own upper tier, on one shared lower tier that stands in for Redis; no bus between them. */
function replicas(): { shared: MemoryCacheStore; aUpper: MemoryCacheStore; bUpper: MemoryCacheStore; a: TieredCacheStore; b: TieredCacheStore } {
  const shared = new MemoryCacheStore();
  const aUpper = new MemoryCacheStore();
  const bUpper = new MemoryCacheStore();
  return { shared, aUpper, bUpper, a: new TieredCacheStore().useTiers(aUpper, shared), b: new TieredCacheStore().useTiers(bUpper, shared) };
}

const entryOf = (value: number, tags: string[], versions: readonly string[]): CacheEntry => ({ value: new Uint8Array([value]), tags, versions, storedAt: Date.now(), ttlMs: 60_000, swrMs: 0 });

async function put(tier: TieredCacheStore, key: string, tags: string[], value: number): Promise<void> {
  await tier.set(key, entryOf(value, tags, await tier.versions(tags)));
}

const valueOf = (read: CacheStoreRead | undefined): number | undefined => (read?.valid === true ? read.entry.value[0] : undefined);
const bumps = (...tags: string[]): TagBump[] => tags.map((tag) => ({ tag, version: `stamp.${tag}` }));
const EVENTUAL: CacheStoreReadOptions = { consistency: 'eventual' };
const STRICT: CacheStoreReadOptions = { consistency: 'strict' };
const TAGGED = { ttl: '1m', tags: ['any:t'] };
const TIERED = { store: 'TieredCacheStore', lower: 'SharedTier' };

const tenant = (id: string): new () => CacheScope => class TenantScope extends CacheScope { public segments(): readonly string[] { return [id]; } };
const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => new Error('expected a rejection'), (error: unknown) => error);

describe('TieredCacheStore', () => {
  afterEach(() => sinon.restore());

  it('eventual: reads what another replica stored through the shared tier, then from its own upper tier', async () => {
    const { shared, a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    const lowerGet = sinon.spy(shared, 'get');
    expect([valueOf(await b.get('k', EVENTUAL)), valueOf(await b.get('k', EVENTUAL)), lowerGet.callCount]).to.deep.eq([7, 7, 1]);
  });

  it("eventual: serves another replica's invalidated value until the bump reaches it over the bus", async () => {
    const { a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    expect(valueOf(await b.get('k', EVENTUAL))).to.eq(7);
    await a.bump(bumps('any:t'));
    expect([valueOf(await a.get('k', EVENTUAL)), valueOf(await b.get('k', EVENTUAL))]).to.deep.eq([undefined, 7]);
    await b.bump(bumps('any:t'));
    expect(valueOf(await b.get('k', EVENTUAL))).to.eq(undefined);
  });

  it("strict: reads every hit from the shared tier, so another replica's bump is seen at once", async () => {
    const { shared, a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    expect(valueOf(await b.get('k', STRICT))).to.eq(7);
    await a.bump(bumps('any:t'));
    const lowerGet = sinon.spy(shared, 'get');
    expect([valueOf(await b.get('k', STRICT)), lowerGet.callCount]).to.deep.eq([undefined, 1]);
  });

  it('does not keep a value it read from the shared tier while a bump arrived', async () => {
    const { shared, bUpper, a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    const read = shared.get.bind(shared);
    sinon.stub(shared, 'get').callsFake(async (key: string) => {
      const found = await read(key);
      bUpper.bumpNow(bumps('any:other'));
      return found;
    });
    expect([valueOf(await b.get('k', EVENTUAL)), bUpper.read('k')]).to.deep.eq([7, undefined]);
  });

  // Fails when the copy is stamped with the time of the copy: it would outlive the entry it copied by 30 s.
  it('copies an entry up with the lifetime it was stored with, so a copy taken later ends when the original does', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const { shared, bUpper, a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    clock.tick(30_000);
    expect(valueOf(await b.get('k', EVENTUAL))).to.eq(7);
    const life = (read: CacheStoreRead | undefined): number[] => [read?.entry.storedAt ?? -1, read?.entry.ttlMs ?? -1, read?.entry.swrMs ?? -1];
    expect(life(bUpper.read('k'))).to.deep.eq(life(shared.read('k')));
    clock.tick(29_999);
    expect(valueOf(await b.get('k', EVENTUAL))).to.eq(7);
    clock.tick(1);
    expect(await b.get('k', EVENTUAL)).to.eq(undefined);
  });

  // Fails when a copy is stamped with the upper tier's current versions while the shared tier missed a bump the upper tier took.
  it('does not trust an entry of the shared tier under a tag whose bump the shared tier refused, until a bump reaches it', async () => {
    const { shared, a, b } = replicas();
    await put(a, 'k', ['any:t'], 7);
    expect(valueOf(await b.get('k', EVENTUAL))).to.eq(7);
    const refused = sinon.stub(shared, 'bump').rejects(new Error('down'));
    await b.bump(bumps('any:t'));
    refused.restore();
    // B took the bump the shared tier refused; A did not, and still reads the old entry there (the known gap).
    expect([valueOf(await b.get('k', EVENTUAL)), valueOf(await b.get('k', STRICT)), valueOf(await a.get('k', STRICT))]).to.deep.eq([undefined, undefined, 7]);
    await b.bump(bumps('any:t'));
    await put(a, 'k', ['any:t'], 8);
    expect(valueOf(await b.get('k', STRICT))).to.eq(8);
  });

  // Fails when a bump acknowledged late clears the distrust that a newer refused bump of its tag set.
  it('keeps distrusting a tag whose newer bump the shared tier refused while an older one was still unacknowledged', async () => {
    const { shared, a } = replicas();
    let ack = (): void => undefined;
    const bump = shared.bump.bind(shared);
    const slow = sinon.stub(shared, 'bump').callsFake(async (applied: readonly TagBump[]) => bump(applied).then(() => new Promise<void>((resolve) => (ack = resolve))));
    const first = a.bump(bumps('any:t'));
    await put(a, 'k', ['any:t'], 7);
    slow.rejects(new Error('down'));
    await a.bump(bumps('any:t'));
    ack();
    await first;
    expect(valueOf(await a.get('k', STRICT))).to.eq(undefined);
  });

  // Fails when the distrust never ends (every later read of the tag misses) or ends before maxTtl.
  it('trusts the shared tier again cache.maxTtl after the bump it refused, when every entry read before it has ended', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const shared = new MemoryCacheStore();
    const tier = new TieredCacheStore().useTiers(new MemoryCacheStore(), shared, new Breaker(5, 10_000), 'shared', 600_000);
    sinon.stub(shared, 'bump').rejects(new Error('down'));
    await tier.bump(bumps('any:t'));
    clock.tick(599_999);
    shared.write('k', entryOf(7, ['any:t'], shared.versionsNow(['any:t'])));
    expect(valueOf(await tier.get('k', STRICT))).to.eq(undefined);
    clock.tick(1);
    shared.write('k', entryOf(8, ['any:t'], shared.versionsNow(['any:t'])));
    expect(valueOf(await tier.get('k', STRICT))).to.eq(8);
  });

  // Fails when a tier is written under versions read at the write: it would hold the value as valid after the bump.
  it('leaves neither tier serving a value whose tag was bumped before or between its two writes', async () => {
    const { shared, a } = replicas();
    const before = await a.versions(['any:t']);
    await a.bump(bumps('any:t'));
    await a.set('late', entryOf(7, ['any:t'], before));
    expect([valueOf(await a.get('late', EVENTUAL)), valueOf(await a.get('late', STRICT))]).to.deep.eq([undefined, undefined]);
    const versions = await a.versions(['any:t']);
    let open = (): void => undefined;
    const lowerWrite = new Promise<void>((resolve) => (open = resolve));
    const write = shared.set.bind(shared);
    sinon.stub(shared, 'set').callsFake(async (key: string, entry: CacheEntry) => lowerWrite.then(() => write(key, entry)));
    const setting = a.set('k', entryOf(7, ['any:t'], versions));
    await a.bump(bumps('any:t'));
    open();
    await setting;
    expect([valueOf(await a.get('k', EVENTUAL)), valueOf(await a.get('k', STRICT))]).to.deep.eq([undefined, undefined]);
  });

  it('keeps an entry in the upper tier alone when the shared tier fails to store it, and drops it there on a bump', async () => {
    const { shared, a } = replicas();
    sinon.stub(shared, 'set').rejects(new Error('down'));
    await put(a, 'k', ['any:t'], 7);
    expect([shared.read('k'), valueOf(await a.get('k', EVENTUAL)), valueOf(await a.get('k', STRICT))]).to.deep.eq([undefined, 7, undefined]);
    await a.bump(bumps('any:t'));
    expect(valueOf(await a.get('k', EVENTUAL))).to.eq(undefined);
  });

  it('serves its upper tier while the shared tier is down, stops calling it, and stores in the upper tier alone', async () => {
    const shared = new MemoryCacheStore();
    const tier = new TieredCacheStore().useTiers(new MemoryCacheStore(), shared, new Breaker(2, 10_000));
    await put(tier, 'k', ['any:t'], 7);
    const down = sinon.stub(shared, 'get').rejects(new Error('down'));
    sinon.stub(shared, 'versions').rejects(new Error('down'));
    expect(valueOf(await tier.get('k', EVENTUAL))).to.eq(7);
    for (let i = 0; i < 3; i += 1) expect(valueOf(await tier.get('j', EVENTUAL))).to.eq(undefined);
    expect(down.callCount).to.eq(2);
    await put(tier, 'n', ['any:t'], 9);
    expect([valueOf(await tier.get('n', EVENTUAL)), shared.read('n')]).to.deep.eq([9, undefined]);
  });

  // Fails when strict falls back to the upper tier while the breaker is open, or when a bump is skipped by the breaker.
  it('while its breaker is open: strict misses, eventual serves the upper tier, bumps still reach the shared tier; one trial closes it', async () => {
    let now = 0;
    const shared = new MemoryCacheStore();
    const tier = new TieredCacheStore().useTiers(new MemoryCacheStore(), shared, new Breaker(2, 1000, () => now));
    await put(tier, 'k', ['any:t'], 7);
    const get = sinon.stub(shared, 'get').rejects(new Error('down'));
    for (let i = 0; i < 2; i += 1) await tier.get('j', EVENTUAL);
    get.restore();
    const lowerGet = sinon.spy(shared, 'get');
    const lowerBump = sinon.stub(shared, 'bump').rejects(new Error('down'));
    expect([valueOf(await tier.get('k', STRICT)), valueOf(await tier.get('k', EVENTUAL))]).to.deep.eq([undefined, 7]);
    await tier.bump(bumps('any:other'));
    now = 999;
    expect([valueOf(await tier.get('k', STRICT)), lowerGet.callCount, lowerBump.callCount]).to.deep.eq([undefined, 0, 1]);
    now = 1000;
    expect([valueOf(await tier.get('k', STRICT)), valueOf(await tier.get('k', STRICT)), lowerGet.callCount]).to.deep.eq([7, 7, 2]);
  });

  it('writes both tiers, the upper one first, and deletes both', async () => {
    const { shared, aUpper, a } = replicas();
    const upperWrite = sinon.spy(aUpper, 'write');
    const lowerSet = sinon.spy(shared, 'set');
    await put(a, 'k', [], 3);
    expect([valueOf(shared.read('k')), upperWrite.calledBefore(lowerSet), lowerSet.callCount]).to.deep.eq([3, true, 1]);
    await a.delete('k');
    expect([shared.read('k'), valueOf(await a.get('k', EVENTUAL))]).to.deep.eq([undefined, undefined]);
  });

  it('is opened from cache.caches.<name> and refuses a tier it cannot use', async () => {
    const tiered = { store: 'TieredCacheStore' };
    const caches = { shared: { ...tiered, lower: 'MemoryCacheStore', consistency: 'strict' }, nolower: tiered, badupper: { ...tiered, upper: 'TieredCacheStore', lower: 'MemoryCacheStore' }, badlower: { ...tiered, lower: 'TieredCacheStore' } };
    const app = await createTestApp({ config: { cache: { ttlJitter: 0, caches } } });
    try {
      expect(await cache('shared').wrap('k', { ttl: '1m' }, async () => 5)).to.eq(5);
      expect(await cache('shared').get('k')).to.eq(5);
      for (const name of ['nolower', 'badupper', 'badlower']) expect(await rejection(cache(name).get('k'))).to.be.instanceOf(CacheConfigError);
    } finally {
      await app.dispose();
    }
  });

  // Fails when a numeric key accepts 0 (or null, which the schema coerces to 0) or a name accepts ''.
  it('refuses at boot a breaker, bus or tier setting it could not run with, and names the key', async () => {
    const wrong: [Record<string, unknown>, string][] = [
      [{ breaker: { failures: 0 } }, 'breaker.failures'],
      [{ breaker: { failures: null } }, 'breaker.failures'],
      [{ breaker: { resetAfter: 0 } }, 'breaker.resetAfter'],
      [{ breaker: { resetAfter: '0s' } }, 'breaker.resetAfter'],
      [{ bus: '' }, 'cache.bus'],
      [{ caches: { s: { store: 'TieredCacheStore', lower: '' } } }, 'caches.s.lower'],
    ];
    for (const [section, key] of wrong) expect(String(await rejection(createTestApp({ config: { cache: section } })))).to.contain(key);
  });
});

describe('TieredCacheStore between two processes', () => {
  let started: TestApp[] = [];

  beforeEach(() => {
    wire.reset();
    SharedTier.reset();
    started = [];
  });

  afterEach(async () => {
    sinon.restore();
    for (const app of started) await app.dispose();
  });

  // Fails when eventual outlives the entry it copied (a restamped copy), and when strict answers from the upper tier.
  it('with a lost bus message: eventual serves the old value until the entry ends, strict misses at once', async () => {
    const caches = { eventual: TIERED, strict: { ...TIERED, consistency: 'strict' } };
    started = [await startProcess(caches), await startProcess(caches)];
    const [a, b] = started.map((app) => app.container);
    const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    for (const name of ['eventual', 'strict']) await cache(name, a).set('k', 'old', TAGGED);
    clock.tick(30_000);
    for (const name of ['eventual', 'strict']) expect(await cache(name, b).get('k')).to.eq('old');
    wire.dropping = true;
    await cache('eventual', a).invalidate(['any:t']);
    expect([await cache('strict', b).get('k'), await cache('eventual', b).get('k')]).to.deep.eq([undefined, 'old']);
    clock.tick(29_999);
    expect(await cache('eventual', b).get('k')).to.eq('old');
    clock.tick(1);
    expect(await cache('eventual', b).get('k')).to.eq(undefined);
  });

  // Fails without the second upper bump: a read while the shared tier takes the bump copies the old entry up under the new versions.
  it('never serves the invalidating process a value stored before its invalidate() resolved, its echo held or lost', async () => {
    started = [await startProcess({ eventual: TIERED, strict: { ...TIERED, consistency: 'strict' } })];
    const a = started[0].container;
    for (const lose of [() => wire.hold(), () => (wire.dropping = true)]) {
      for (const name of ['eventual', 'strict']) await cache(name, a).set('k', 'old', TAGGED);
      let open = (): void => undefined;
      SharedTier.gate = new Promise((resolve) => (open = resolve));
      lose();
      const invalidating = cache('eventual', a).invalidate(['any:t']);
      await drain();
      expect(await cache('eventual', a).get('k')).to.eq('old');
      open();
      await invalidating;
      expect([await cache('eventual', a).get('k'), await cache('strict', a).get('k')]).to.deep.eq([undefined, undefined]);
    }
  });

  // Fails when the shared tier keys an entry without the scope part of the key the cache built.
  it('never lets two tenants share an entry through either tier', async () => {
    for (const id of ['t1', 't2']) started.push(await startProcess({ shared: TIERED }, (c) => c.register(tenant(id)).as(CacheScope)));
    const [one, two] = started.map((app) => app.container);
    expect([await cache('shared', one).wrap('k', TAGGED, async () => 'one'), await cache('shared', two).get('k')]).to.deep.eq(['one', undefined]);
  });
});

import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { CacheConfigError, CacheScope, CacheStore, CacheValueNotSerializable, MemoryCacheStore, cache } from '../src/index.js';
import type { CacheStoreRead, TagBump } from '../src/index.js';

@NewInstance()
@Injectable(CacheStore)
class BrokenStore extends MemoryCacheStore {
  public async get(): Promise<CacheStoreRead | undefined> {
    throw new Error('store down');
  }
}

@NewInstance()
@Injectable(CacheStore)
class CountingStore extends MemoryCacheStore {
  public static bumped: string[] = [];

  public async bump(bumps: readonly TagBump[]): Promise<void> {
    CountingStore.bumped.push(...bumps.map((bump) => bump.tag));
    await super.bump(bumps);
  }
}

@NewInstance()
@Injectable(CacheStore)
class RefusingStore extends MemoryCacheStore {
  public async bump(): Promise<void> {
    throw new Error('store down');
  }
}

@NewInstance()
@Injectable(CacheStore)
class UnreachableStore extends MemoryCacheStore {
  public async configure(): Promise<void> {
    throw new Error('connection refused');
  }
}

class TenantScope extends CacheScope {
  public static current: string[] | null = [];
  public segments(): readonly string[] | null {
    return TenantScope.current;
  }
}

const CONFIG = { cache: { ttlJitter: 0, maxTtl: '10m', caches: { default: {}, reports: {}, broken: { store: BrokenStore.name }, missing: { store: 'NoSuchStore' }, counted: { store: CountingStore.name }, refusing: { store: RefusingStore.name }, unreachable: { store: UnreachableStore.name } } } };

function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('cache()', () => {
  let app: TestApp;
  let clock: sinon.SinonFakeTimers;

  beforeEach(async () => {
    app = await createTestApp({ config: CONFIG, register: (container) => container.register(TenantScope).as(CacheScope) });
    clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    TenantScope.current = [];
    CountingStore.bumped = [];
  });

  afterEach(async () => {
    clock.restore();
    await app.dispose();
  });

  it('gives back a copy of what was set, under the default cache', async () => {
    const row = { id: 1, at: new Date(0) };
    await cache().set('k', row, { ttl: '1m' });
    const back = await cache('default').get<typeof row>('k');
    expect(back).to.deep.eq(row);
    expect(back).to.not.eq(row);
    expect(await cache().get('other')).to.eq(undefined);
  });

  it('drops an entry once one of its tags is invalidated, in every cache', async () => {
    await cache().set('a', 1, { ttl: '1m', tags: ['row:invoice:1'] });
    await cache('reports').set('b', 2, { ttl: '1m', tags: ['row:invoice:1', 'any:invoice'] });
    await cache().set('c', 3, { ttl: '1m', tags: ['row:invoice:2'] });
    await cache('reports').invalidate(['row:invoice:1']);
    expect([await cache().get('a'), await cache('reports').get('b'), await cache().get('c')]).to.deep.eq([undefined, undefined, 3]);
  });

  it('stores a value computed before an invalidation as already invalid', async () => {
    const miss = await cache().lookup<number>('k', { ttl: '1m', tags: ['any:invoice'] });
    expect(miss.hit).to.eq(false);
    await cache().invalidate(['any:invoice']);
    if (!miss.hit) await miss.fill(1);
    expect(await cache().get('k')).to.eq(undefined);
    const next = await cache().lookup<number>('k', { ttl: '1m', tags: ['any:invoice'] });
    if (!next.hit) await next.fill(2);
    expect(await cache().lookup<number>('k', { ttl: '1m' })).to.deep.include({ hit: true, value: 2, stale: false });
  });

  it('expires an entry after its ttl and caps every ttl at cache.maxTtl', async () => {
    await cache().set('short', 1, { ttl: '1m' });
    await cache().set('long', 2, { ttl: '1h' });
    clock.tick(60_000);
    expect(await cache().get('short')).to.eq(undefined);
    clock.tick(539_999);
    expect(await cache().get('long')).to.eq(2);
    clock.tick(1);
    expect(await cache().get('long')).to.eq(undefined);
  });

  it('throws for a ttl not above 0, a value v8 would change, an unknown cache and an unknown store', async () => {
    expect(await rejection(cache().set('k', 1, { ttl: 0 }))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(cache().set('k', { fn: () => 1 }, { ttl: '1m' }))).to.be.instanceOf(CacheValueNotSerializable);
    expect(await rejection(cache('nope').get('k'))).to.be.instanceOf(CacheConfigError);
    // Fails when a cache name is looked up on the plain object, which finds Object.prototype.constructor.
    expect(await rejection(cache('constructor').get('k'))).to.be.instanceOf(CacheConfigError);
    expect(await rejection(cache('missing').get('k'))).to.be.instanceOf(CacheConfigError);
  });

  it('keys every entry by the CacheScope segments, and caches nothing where a scope answers null', async () => {
    TenantScope.current = ['t1'];
    await cache().set('k', 't1', { ttl: '1m' });
    TenantScope.current = ['t2'];
    expect(await cache().get('k')).to.eq(undefined);
    await cache().set('k', 't2', { ttl: '1m' });
    TenantScope.current = ['t1'];
    expect(await cache().get('k')).to.eq('t1');
    TenantScope.current = null;
    let runs = 0;
    const compute = async (): Promise<number> => (runs += 1);
    await cache().wrap('w', { ttl: '1m' }, compute);
    await cache().wrap('w', { ttl: '1m' }, compute);
    expect(runs).to.eq(2);
    expect(await cache().get('k')).to.eq(undefined);
  });

  it('reads a store failure as a miss and still returns the computed value', async () => {
    let runs = 0;
    const value = await cache('broken').wrap('k', { ttl: '1m' }, async () => {
      runs += 1;
      return 'fresh';
    });
    expect([value, runs]).to.deep.eq(['fresh', 1]);
    expect(await cache('broken').get('k')).to.eq(undefined);
  });

  it('computes on a miss and serves the stored value afterwards', async () => {
    let runs = 0;
    const compute = async (): Promise<number> => (runs += 1);
    expect(await cache().wrap('k', { ttl: '1m' }, compute)).to.eq(1);
    expect(await cache().wrap('k', { ttl: '1m' }, compute)).to.eq(1);
    expect(runs).to.eq(1);
  });

  // Fails when a forgotten version reads as a fixed '0' and the lifetime counts from the write.
  it('keeps a value computed before an invalidation invalid for the whole of its life', async () => {
    const miss = await cache().lookup<number>('k', { ttl: '10m', tags: ['any:invoice'] });
    clock.tick(1000);
    await cache().invalidate(['any:invoice']);
    clock.tick(1000);
    if (!miss.hit) await miss.fill(1);
    clock.tick(599_500);
    // A bump makes the memory store forget the versions it has not used for maxTtl.
    await cache().invalidate(['any:other']);
    expect(await cache().get('k')).to.eq(undefined);
  });

  // Fails when the lifetime counts from the write: the entry would live until nine minutes from now.
  it('ends an entry cache.maxTtl after its versions were read, however late it was filled', async () => {
    const miss = await cache().lookup<number>('k', { ttl: '10m', tags: ['any:t'] });
    clock.tick(540_000);
    if (!miss.hit) await miss.fill(1);
    expect(await cache().get('k')).to.eq(1);
    clock.tick(60_000);
    expect(await cache().get('k')).to.eq(undefined);
  });

  // Fails when the lifetime counts from the write: a slow computation would store an entry that lives a full maxTtl.
  it('ends an entry cache.maxTtl after its versions were read, however long wrap computed it', async () => {
    const slow = async (): Promise<number> => {
      clock.tick(540_000);
      return 1;
    };
    expect(await cache().wrap('k', { ttl: '10m', tags: ['any:t'] }, slow)).to.eq(1);
    expect(await cache().get('k')).to.eq(1);
    clock.tick(60_000);
    expect(await cache().get('k')).to.eq(undefined);
  });

  // Fails when a stale hit has no fill, when its fill reads the versions at fill time, or when the lookup deletes the entry.
  it('gives a stale lookup hit a fill that stores under the versions of that lookup and leaves the entry in place', async () => {
    const options = { ttl: '1m', swr: '1m', tags: ['any:t'] };
    await cache().set('k', 'old', options);
    clock.tick(60_000);
    const stale = await cache().lookup<string>('k', options);
    const other = await cache().lookup<string>('k', options);
    expect([stale.hit && stale.stale, other.hit && other.value]).to.deep.eq([true, 'old']);
    if (stale.hit) await stale.fill?.('new');
    const fresh = await cache().lookup<string>('k', options);
    expect(fresh).to.deep.eq({ hit: true, value: 'new', stale: false });
    clock.tick(60_000);
    const late = await cache().lookup<string>('k', options);
    await cache().invalidate(['any:t']);
    if (late.hit) await late.fill?.('from before the invalidation');
    expect(await cache().get('k')).to.eq(undefined);
  });

  // Fails when an invalidation reaches only the caches this process has read or written through.
  // From v4-ca-02 the bus echo bumps the tag a second time, so the count is not pinned.
  it('bumps the store of every configured cache, also one this process never used, and survives one it cannot open', async () => {
    await cache().invalidate(['any:t']);
    expect(CountingStore.bumped).to.include('any:t');
  });

  // Fails when the versions are read after compute() instead of before it.
  it('stores a value whose computation an invalidation overlapped as already invalid', async () => {
    const started = gate<void>();
    const value = gate<string>();
    const first = cache().wrap('k', { ttl: '1m', tags: ['any:t'] }, () => {
      started.open();
      return value.promise;
    });
    await started.promise;
    await cache().invalidate(['any:t']);
    value.open('old');
    expect(await first).to.eq('old');
    expect(await cache().get('k')).to.eq(undefined);
  });

  it('resolves an invalidation that one store refuses, and still bumps the others', async () => {
    await cache().set('k', 1, { ttl: '1m', tags: ['any:t'] });
    await cache().invalidate(['any:t']);
    // The bump and the bus echo of it, which applies the bump again.
    await new Promise((resolve) => setImmediate(resolve));
    expect([await cache().get('k'), CountingStore.bumped]).to.deep.eq([undefined, ['any:t', 'any:t']]);
  });

  it('reads a store that fails to open as a miss and still returns the computed value', async () => {
    expect(await cache('unreachable').wrap('k', { ttl: '1m' }, async () => 'fresh')).to.eq('fresh');
    await cache('unreachable').set('k', 1, { ttl: '1m' });
    expect(await cache('unreachable').get('k')).to.eq(undefined);
  });
});

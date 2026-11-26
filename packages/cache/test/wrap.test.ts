import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import { Injectable, NewInstance } from '@spinajs/di';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { CacheScope, CacheStore, MemoryCacheStore, cache } from '../src/index.js';

@NewInstance()
@Injectable(CacheStore)
class NoVersionsStore extends MemoryCacheStore {
  public async versions(): Promise<readonly string[]> {
    throw new Error('store down');
  }
}

class TenantScope extends CacheScope {
  public static current: string[] = [];
  public segments(): readonly string[] {
    return TenantScope.current;
  }
}

const CONFIG = { cache: { ttlJitter: 0, maxTtl: '10m', caches: { default: {}, noversions: { store: NoVersionsStore.name } } } };
const STALE = { ttl: '1m', swr: '1m', tags: ['any:t'] };
const TAGGED = { ttl: '1m', tags: ['any:t'] };

interface Gate<T = void> {
  readonly promise: Promise<T>;
  open(value: T): void;
  fail(error: unknown): void;
}

function gate<T = void>(): Gate<T> {
  let open: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

// The stores here are in memory, so every promise chain a call starts has run once the macrotask queue is reached.
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What `promise` settled to once every pending chain ran; 'pending' when it still waits (for a gate). */
async function stateOf<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, drain().then(() => 'pending' as const)]);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** A compute() that counts its runs, opens `started` when it runs, and answers what `value` is opened with. */
function gated<T>(value: Gate<T>, started: Gate = gate()): { compute: () => Promise<T>; started: Promise<void>; runs: () => number } {
  let runs = 0;
  const compute = (): Promise<T> => {
    runs += 1;
    started.open();
    return value.promise;
  };
  return { compute, started: started.promise, runs: () => runs };
}

describe('cache().wrap', () => {
  let app: TestApp;
  let clock: sinon.SinonFakeTimers;

  beforeEach(async () => {
    app = await createTestApp({ config: CONFIG, register: (container) => container.register(TenantScope).as(CacheScope) });
    clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    TenantScope.current = [];
  });

  afterEach(async () => {
    clock.restore();
    await app.dispose();
  });

  // Fails without single flight (three runs) and when joiners share the computation's own object.
  it('runs one computation for concurrent misses of a key and gives every caller its own copy', async () => {
    const value = gate<{ n: number }>();
    const slow = gated(value);
    const callers = [1, 2, 3].map(() => cache().wrap('k', TAGGED, slow.compute));
    await drain();
    value.open({ n: 1 });
    const [a, b, c] = await Promise.all(callers);
    expect(slow.runs()).to.eq(1);
    expect([a, b, c]).to.deep.eq([{ n: 1 }, { n: 1 }, { n: 1 }]);
    expect(a).to.not.eq(b);
    expect(b).to.not.eq(c);
  });

  // Fails when a rejected computation stays the key's running one: the next call would get the same error.
  it('rejects every waiting caller with the error of the computation, stores nothing, and computes again on the next call', async () => {
    const value = gate<number>();
    const slow = gated(value);
    const waiting = [1, 2].map(() => rejection(cache().wrap('k', TAGGED, slow.compute)));
    await drain();
    const boom = new Error('boom');
    value.fail(boom);
    const [first, second] = await Promise.all(waiting);
    expect([first === boom, second === boom, slow.runs()]).to.deep.eq([true, true, 1]);
    expect(await cache().get('k')).to.eq(undefined);
    expect(await cache().wrap('k', TAGGED, async () => 2)).to.eq(2);
  });

  // Fails when a stale key is computed in the caller (the call waits for the gate) and when each stale read refreshes.
  it('serves a stale value at once while one refresh runs, then the refreshed value', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(60_000);
    const value = gate<string>();
    const refresh = gated(value);
    expect(await stateOf(cache().wrap('k', STALE, refresh.compute))).to.eq('old');
    await refresh.started;
    expect(await stateOf(cache().wrap('k', STALE, refresh.compute))).to.eq('old');
    value.open('new');
    await drain();
    expect(refresh.runs()).to.eq(1);
    expect(await cache().get('k')).to.eq('new');
  });

  // Fails when a failed refresh reaches the caller, deletes the stale entry, or stays the key's running computation.
  it('keeps serving the stale value when a refresh fails, refreshes again on the next stale read, and misses once the window ended', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(60_000);
    let runs = 0;
    const failing = async (): Promise<string> => {
      runs += 1;
      throw new Error('db down');
    };
    expect(await cache().wrap('k', STALE, failing)).to.eq('old');
    await drain();
    clock.tick(59_999);
    expect(await cache().wrap('k', STALE, failing)).to.eq('old');
    await drain();
    expect(runs).to.eq(2);
    clock.tick(1);
    expect(await cache().wrap('k', STALE, async () => 'new')).to.eq('new');
  });

  // Fails when the background refresh is started without a catch, or a flight is freed with finally(), whose promise rejects too.
  it('lets no rejection of a background refresh escape', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      await cache().wrap('k', STALE, async () => 'old');
      clock.tick(60_000);
      const value = gate<string>();
      const refresh = gated(value);
      expect(await stateOf(cache().wrap('k', STALE, refresh.compute))).to.eq('old');
      await refresh.started;
      value.fail(new Error('db down'));
      await drain();
      await drain();
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).to.deep.eq([]);
  });

  it('computes in the caller once the swr window has passed', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(120_000);
    expect(await cache().wrap('k', STALE, async () => 'new')).to.eq('new');
  });

  // Fails when a stale hit is decided by age alone: the invalidated value would be served while a refresh runs.
  it('never serves an invalidated value as stale', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(60_000);
    await cache().invalidate(['any:t']);
    expect(await cache().wrap('k', STALE, async () => 'new')).to.eq('new');
  });

  // BET8-A-F1. Fails with a flight keyed by the store key alone (the late caller gets 'old'), when joiners compute
  // again (two runs), and when the older computation still writes over the newer entry.
  it('does not hand a caller that arrives after an invalidation the computation a waiter joined before it', async () => {
    const old = gate<string>();
    const slow = gated(old);
    const first = cache().wrap('k', TAGGED, slow.compute);
    await slow.started;
    const joined = cache().wrap('k', TAGGED, slow.compute);
    await drain();
    await cache().invalidate(['any:t']);
    expect(await stateOf(cache().wrap('k', TAGGED, async () => 'new'))).to.eq('new');
    old.open('old');
    expect([await first, await joined, slow.runs()]).to.deep.eq(['old', 'old', 1]);
    expect(await cache().get('k')).to.eq('new');
  });

  // Fails when a miss joins a refresh by key alone (it gets the refresh's value), and when the older refresh still writes.
  it('does not hand a caller that misses after an invalidation the value of a refresh that began before it', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(60_000);
    const refreshed = gate<string>();
    const refresh = gated(refreshed);
    expect(await stateOf(cache().wrap('k', STALE, refresh.compute))).to.eq('old');
    await refresh.started;
    await cache().invalidate(['any:t']);
    const miss = cache().wrap('k', STALE, async () => 'new');
    expect(await stateOf(miss)).to.eq('new');
    refreshed.open('from before the invalidation');
    await drain();
    expect(await cache().get('k')).to.eq('new');
  });

  // Fails when a refresh reads its versions after compute() (or at the write): its value would be stored as valid.
  it('stores the value of a refresh under the versions read before it began', async () => {
    await cache().wrap('k', STALE, async () => 'old');
    clock.tick(60_000);
    const refreshed = gate<string>();
    const refresh = gated(refreshed);
    expect(await stateOf(cache().wrap('k', STALE, refresh.compute))).to.eq('old');
    await refresh.started;
    await cache().invalidate(['any:t']);
    refreshed.open('from before the invalidation');
    await drain();
    expect(await cache().get('k')).to.eq(undefined);
  });

  // Fails with a flight keyed by the caller's key instead of the store key: the second tenant would get the first's value.
  it('never lets two scopes share a computation of the same key', async () => {
    TenantScope.current = ['t1'];
    const forT1 = gate<string>();
    const slow = gated(forT1);
    const first = cache().wrap('k', TAGGED, slow.compute);
    await slow.started;
    TenantScope.current = ['t2'];
    expect(await stateOf(cache().wrap('k', TAGGED, async () => 'for t2'))).to.eq('for t2');
    forT1.open('for t1');
    expect(await first).to.eq('for t1');
    expect(await cache().get('k')).to.eq('for t2');
    TenantScope.current = ['t1'];
    expect(await cache().get('k')).to.eq('for t1');
  });

  // BET8-A-FX3. Fails when callers join by key while nobody can tell the versions: the second would wait for the first.
  it('lets every caller compute on its own while the store cannot tell the versions', async () => {
    const value = gate<number>();
    const slow = gated(value);
    const first = cache('noversions').wrap('k', TAGGED, slow.compute);
    await slow.started;
    expect(await stateOf(cache('noversions').wrap('k', TAGGED, async () => 2))).to.eq(2);
    value.open(1);
    expect([await first, slow.runs()]).to.deep.eq([1, 1]);
  });

  // Fails when a settled computation stays in the map (it grows with every key), and when a settling older computation
  // frees its key although a newer one replaced it (the joiner below would then compute on its own).
  it('forgets every computation once it settled, resolved, rejected or replaced', async () => {
    const first = gate<string>();
    const failing = gate<string>();
    const older = cache().wrap('k', TAGGED, () => first.promise);
    const other = rejection(cache().wrap('other', TAGGED, () => failing.promise));
    await drain();
    await cache().invalidate(['any:t']);
    const second = gate<string>();
    const slow = gated(second);
    const newer = cache().wrap('k', TAGGED, slow.compute);
    await slow.started;
    first.open('older');
    failing.fail(new Error('db down'));
    await Promise.all([older, other]);
    const joined = cache().wrap('k', TAGGED, slow.compute);
    await drain();
    second.open('newer');
    expect([await newer, await joined, slow.runs()]).to.deep.eq(['newer', 'newer', 1]);
    await Promise.all([cache().delete('k'), cache().delete('other')]);
    let runs = 0;
    const counted = async (): Promise<string> => {
      runs += 1;
      return 'again';
    };
    await Promise.all([cache().wrap('k', TAGGED, counted), cache().wrap('other', TAGGED, counted)]);
    expect(runs).to.eq(2);
  });

  // Fails when a settled computation stays the key's running one: the next miss would get its old value without computing.
  it('computes a key again once its computation settled and the entry was deleted, for every key', async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
    await Promise.all(keys.map((key) => cache().wrap(key, TAGGED, async () => key)));
    await Promise.all(keys.map((key) => cache().delete(key)));
    let runs = 0;
    const counted = async (): Promise<string> => {
      runs += 1;
      return 'again';
    };
    await Promise.all(keys.map((key) => cache().wrap(key, TAGGED, counted)));
    expect(runs).to.eq(keys.length);
  });
});

describe('cache.ttlJitter', () => {
  let app: TestApp | undefined;
  let clock: sinon.SinonFakeTimers;
  let random: sinon.SinonStub<[], number>;

  async function boot(ttlJitter: number): Promise<void> {
    app = await createTestApp({ config: { cache: { ttlJitter, maxTtl: '10m', caches: { default: {} } } } });
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    // Restored on its own: sinon.restore() would also take back the fake Date.
    random = sinon.stub(Math, 'random');
  });

  afterEach(async () => {
    random.restore();
    clock.restore();
    await app?.dispose();
    app = undefined;
  });

  /** Whether an entry wrap() stores with `ttl`, while Math.random() answers `draw`, is still there 1 ms before `ms`, and at `ms`. */
  async function lifeOf(key: string, ttl: string, draw: number, ms: number): Promise<string> {
    random.returns(draw);
    await cache().wrap(key, { ttl }, async () => 1);
    clock.tick(ms - 1);
    const before = (await cache().get(key)) === undefined ? 'gone' : 'there';
    clock.tick(1);
    const after = (await cache().get(key)) === undefined ? 'gone' : 'there';
    return `${before} at ${ms - 1}, ${after} at ${ms}`;
  }

  // Fails when the spread lengthens a ttl (90 s at draw 1) or ignores the drawn fraction.
  it('shortens a ttl by the drawn fraction of cache.ttlJitter: draw 1 gives ttl * (1 - jitter), draw 0 the ttl itself', async () => {
    await boot(0.5);
    expect(await lifeOf('low', '1m', 1, 30_000)).to.eq('there at 29999, gone at 30000');
    expect(await lifeOf('mid', '1m', 0.5, 45_000)).to.eq('there at 44999, gone at 45000');
    expect(await lifeOf('high', '1m', 0, 60_000)).to.eq('there at 59999, gone at 60000');
  });

  // Fails when the spread is applied before the cap: a ttl above maxTtl would then never be spread (10 min, not 7.5).
  it('spreads a ttl after capping it at cache.maxTtl, so no entry lives past it', async () => {
    await boot(0.5);
    expect(await lifeOf('capped', '2h', 0, 600_000)).to.eq('there at 599999, gone at 600000');
    expect(await lifeOf('spread', '2h', 0.5, 450_000)).to.eq('there at 449999, gone at 450000');
  });

  // Fails when a ttlJitter of 0 falls back to the default spread of 0.1 (54 s).
  it('changes no ttl when cache.ttlJitter is 0', async () => {
    await boot(0);
    expect(await lifeOf('k', '1m', 1, 60_000)).to.eq('there at 59999, gone at 60000');
  });

  // Fails when the schema leaves ttlJitter unbounded.
  it('refuses a cache.ttlJitter outside 0 to 0.5 at boot and names the key', async () => {
    for (const ttlJitter of [0.6, -0.1]) {
      const error = await rejection(boot(ttlJitter));
      expect(String(error)).to.contain('ttlJitter');
    }
  });
});

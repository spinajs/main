import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { ManualClock, RefreshingCache } from '../src/index.js';

chai.use(chaiAsPromised);

/** A load whose results are scripted: each entry is a value, or an Error to reject with. */
function scripted(...results: (string | Error)[]) {
  const calls: number[] = [];
  const load = async (now: number) => {
    calls.push(now);
    const r = results.shift();
    if (r === undefined) throw new Error('no more results');
    if (r instanceof Error) throw r;
    return r;
  };
  return { load, calls };
}

describe('RefreshingCache', () => {
  it('loads on first use and serves the value until maxAge', async () => {
    const { load, calls } = scripted('v1', 'v2');
    const cache = new RefreshingCache({ load, maxAgeMs: 100 });
    expect(await cache.get(1000)).to.eq('v1');
    expect(await cache.get(1099)).to.eq('v1');
    expect(cache.fetchedAt).to.eq(1000);
    expect(await cache.get(1100)).to.eq('v2');
    expect(calls).to.deep.eq([1000, 1100]);
  });

  it('shares one load between concurrent callers', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const cache = new RefreshingCache({
      load: () => {
        calls++;
        return new Promise<string>((r) => (release = r));
      },
      maxAgeMs: 100,
    });
    const a = cache.get(0);
    const b = cache.get(0);
    const c = cache.refresh(0);
    await Promise.resolve();
    release('v');
    expect(await Promise.all([a, b, c])).to.deep.eq(['v', 'v', 'v']);
    expect(calls).to.eq(1);
  });

  describe('failure cooldown (retryAfterFailureMs)', () => {
    it('serves the last good value when a reload fails, and waits before the next attempt', async () => {
      const { load, calls } = scripted('v1', new Error('down'), 'v2');
      const cache = new RefreshingCache({ load, maxAgeMs: 100, retryAfterFailureMs: 50 });
      await cache.get(0);
      expect(await cache.get(100)).to.eq('v1');
      expect(await cache.get(149)).to.eq('v1');
      expect(calls).to.deep.eq([0, 100]);
      expect(await cache.get(150)).to.eq('v2');
      expect(calls).to.deep.eq([0, 100, 150]);
    });

    it('without a value, rejects with the load error and then with the cooling-down error', async () => {
      const { load } = scripted(new Error('down'), 'v1');
      const cache = new RefreshingCache({ load, maxAgeMs: 100, retryAfterFailureMs: 50, coolingDownError: () => new Error('cooling') });
      await expect(cache.get(0)).to.be.rejectedWith('down');
      await expect(cache.get(10)).to.be.rejectedWith('cooling');
      expect(await cache.get(50)).to.eq('v1');
    });

    it('does not hold back loads after a success', async () => {
      const { load, calls } = scripted('v1', 'v2');
      const cache = new RefreshingCache({ load, maxAgeMs: 100, retryAfterFailureMs: 50 });
      await cache.get(0);
      expect(await cache.refresh(1)).to.eq('v2');
      expect(calls).to.deep.eq([0, 1]);
    });
  });

  describe('attempt interval (minIntervalMs)', () => {
    it('holds back a forced refresh until the interval since the last attempt passed', async () => {
      const { load, calls } = scripted('v1', 'v2');
      const cache = new RefreshingCache({ load, maxAgeMs: 1000, minIntervalMs: 60 });
      await cache.get(0);
      expect(await cache.refresh(59)).to.eq('v1');
      expect(calls).to.deep.eq([0]);
      expect(await cache.refresh(60)).to.eq('v2');
      expect(calls).to.deep.eq([0, 60]);
    });

    it('counts a failed attempt too', async () => {
      const { load, calls } = scripted(new Error('down'), 'v1');
      const cache = new RefreshingCache({ load, maxAgeMs: 1000, minIntervalMs: 60 });
      await expect(cache.get(0)).to.be.rejectedWith('down');
      await expect(cache.get(30)).to.be.rejectedWith(/failed recently/);
      expect(await cache.get(60)).to.eq('v1');
      expect(calls).to.deep.eq([0, 60]);
    });
  });

  it('calls onRefresh with each new value', async () => {
    const { load } = scripted('v1', new Error('down'), 'v2');
    const seen: string[] = [];
    const cache = new RefreshingCache({ load, maxAgeMs: 10, onRefresh: (v: string) => seen.push(v) });
    await cache.get(0);
    await cache.get(10);
    await cache.get(20);
    expect(seen).to.deep.eq(['v1', 'v2']);
  });

  it('takes now from the clock when a call passes none', async () => {
    const clock = new ManualClock(new Date(5000));
    const { load, calls } = scripted('v1', 'v2');
    const cache = new RefreshingCache({ load, maxAgeMs: 100, clock });
    await cache.get();
    clock.advance(100);
    expect(await cache.get()).to.eq('v2');
    expect(calls).to.deep.eq([5000, 5100]);
  });

  it('rejects a time that is not finite', async () => {
    const cache = new RefreshingCache({ load: async () => 'v', maxAgeMs: 100 });
    await expect(cache.get(NaN)).to.be.rejectedWith(InvalidArgument);
    await expect(cache.refresh(Infinity)).to.be.rejectedWith(InvalidArgument);
  });

  it('turns a synchronous throw of load into a failed attempt', async () => {
    const cache = new RefreshingCache<string>({
      load: () => {
        throw new Error('sync');
      },
      maxAgeMs: 100,
    });
    await expect(cache.get(0)).to.be.rejectedWith('sync');
    expect(cache.value).to.be.undefined;
  });
});

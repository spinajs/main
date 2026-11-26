import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { CacheScope, CacheService, InProcessTagBus, TagBus, cache, preferTagBus, preferredTagBus, stampBumps } from '../src/index.js';
import type { TagBump } from '../src/index.js';
import { SharedTier, drain, startProcess, wire } from './support/processes.js';

class RecordingBus extends InProcessTagBus {
  public static published: TagBump[][] = [];

  public async publish(bumps: readonly TagBump[]): Promise<void> {
    RecordingBus.published.push([...bumps]);
    await super.publish(bumps);
  }
}

class FailingBus extends TagBus {
  public async publish(): Promise<void> { throw new Error('bus down'); }
  public subscribe(): () => void { return () => undefined; }
}

class PreferredBus extends FailingBus {}

class LateBus extends FailingBus {}

class SecretScope extends CacheScope {
  public segments(): readonly string[] { return ['tenant-secret']; }
}

const CONFIG = { cache: { ttlJitter: 0, caches: { default: {} } } };
const TAGGED = { ttl: '1m', tags: ['any:t'] };
const busOf = async (app: TestApp): Promise<TagBus> => (await app.resolve(CacheService)).bus;

async function withApp(options: Parameters<typeof createTestApp>[0], fn: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await createTestApp(options);
  try {
    await fn(app);
  } finally {
    await app.dispose();
  }
}

describe('TagBus', () => {
  it('InProcessTagBus delivers to every subscriber until it unsubscribes, past a throwing one', async () => {
    const bus = new InProcessTagBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const delivered: TagBump[] = [];
    const stop = bus.subscribe((bumps) => {
      seen.push(...bumps.map((bump) => bump.tag));
      delivered.push(...bumps);
    });
    const published = stampBumps(['a']);
    await bus.publish(published);
    stop();
    await bus.publish(stampBumps(['b']));
    expect(seen).to.deep.eq(['a']);
    // The contract every TagBus keeps: a bump arrives with the stamp it was published with (echo suppression of other packages relies on it).
    expect(delivered).to.deep.eq(published);
  });

  it('rejects every cache call while cache.bus names no registered bus, and resolves once the bus is registered', async () => {
    await withApp({ config: { cache: { ...CONFIG.cache, bus: LateBus.name } } }, async (app) => {
      let error: unknown;
      await cache()
        .get('k')
        .catch((caught: unknown) => {
          error = caught;
        });
      expect(error).to.be.instanceOf(InvalidOption);
      app.container.register(LateBus).as(TagBus);
      expect(await cache().get('k')).to.eq(undefined);
      expect(await busOf(app)).to.be.instanceOf(LateBus);
    });
  });

  it('picks the registered bus with the highest rank, and never an unranked one', () => {
    preferTagBus('RankedForTest', 5);
    expect(preferredTagBus(['InProcessTagBus', 'Unranked'])).to.eq('InProcessTagBus');
    expect(preferredTagBus(['InProcessTagBus', 'RankedForTest'])).to.eq('RankedForTest');
    expect(preferredTagBus(['Unranked'])).to.eq(undefined);
  });

  it('defaults to InProcessTagBus, yields to a preferred bus, and takes cache.bus over both', async () => {
    const register = (container: IContainer) => container.register(PreferredBus).as(TagBus);
    await withApp({ config: CONFIG }, async (app) => {
      expect(await busOf(app)).to.be.instanceOf(InProcessTagBus);
    });
    preferTagBus(PreferredBus.name, 10);
    await withApp({ config: CONFIG, register }, async (app) => {
      expect(await busOf(app)).to.be.instanceOf(PreferredBus);
    });
    await withApp({ config: { cache: { ...CONFIG.cache, bus: 'InProcessTagBus' } }, register }, async (app) => {
      expect(await busOf(app)).to.be.instanceOf(InProcessTagBus);
    });
  });

  it('publishes the bumps of an invalidation, one per tag, each with its own stamp', async () => {
    RecordingBus.published = [];
    const register = (container: IContainer) => container.register(RecordingBus).as(TagBus);
    await withApp({ config: { cache: { ...CONFIG.cache, bus: RecordingBus.name } }, register }, async () => {
      await cache().invalidate(['any:a', 'any:b', 'any:a']);
      expect(RecordingBus.published.map((bumps) => bumps.map((bump) => bump.tag))).to.deep.eq([['any:a', 'any:b']]);
      const [a, b] = RecordingBus.published[0];
      expect(a.version).to.not.eq(b.version);
    });
  });

  it('applies the bumps the bus delivers', async () => {
    await withApp({ config: CONFIG }, async (app) => {
      await cache().set('k', 1, TAGGED);
      await (await busOf(app)).publish(stampBumps(['any:t']));
      await drain();
      expect(await cache().get('k')).to.eq(undefined);
    });
  });

  it('keeps the local invalidation when the bus fails to publish', async () => {
    const register = (container: IContainer) => container.register(FailingBus).as(TagBus);
    await withApp({ config: { cache: { ...CONFIG.cache, bus: FailingBus.name } }, register }, async () => {
      await cache().set('k', 1, TAGGED);
      await cache().invalidate(['any:t']);
      expect(await cache().get('k')).to.eq(undefined);
    });
  });
});

describe('TagBus between two processes', () => {
  const SHARED = { default: {}, shared: { store: 'TieredCacheStore', lower: 'SharedTier' } };
  let started: TestApp[] = [];
  const start = async (caches: Record<string, Record<string, unknown>> = SHARED, register?: (container: IContainer) => void): Promise<IContainer> => {
    const app = await startProcess(caches, register);
    started.push(app);
    return app.container;
  };

  beforeEach(() => {
    wire.reset();
    SharedTier.reset();
    started = [];
  });

  afterEach(async () => {
    sinon.restore();
    for (const app of started) await app.dispose();
  });

  // Fails when a delivery is not applied, and when one throwing subscriber keeps it from the next.
  it("carries an invalidation of process A to process B's caches, past a subscriber that throws", async () => {
    const [a, b] = [await start(), await start()];
    const stop = wire.subscribe(() => { throw new Error('bad subscriber'); });
    await cache('default', b).set('k', 'old', TAGGED);
    wire.hold();
    await cache('default', a).invalidate(['any:t']);
    // Until the bus delivers, B has heard of nothing: that delay is the bound of an `eventual` read.
    expect(await cache('default', b).get('k')).to.eq('old');
    await wire.deliver();
    await drain();
    expect(await cache('default', b).get('k')).to.eq(undefined);
    stop();
  });

  // Fails when a delivery bumps only the caches this process has already used: B would serve the old entry of the shared tier.
  it('applies a delivery to a cache this process has not opened yet, so its shared tier hears it', async () => {
    const writer = await startProcess(SHARED);
    await cache('shared', writer.container).set('k', 'old', TAGGED);
    await writer.dispose();
    const b = await start();
    await cache('default', b).get('warm-up');
    // A process that only publishes, as a write inside a transaction does.
    await wire.send(stampBumps(['any:t']));
    await drain();
    expect(await cache('shared', b).get('k')).to.eq(undefined);
  });

  // Fails when the echo of a process's own bumps is not applied: the entry stored between the local bump and the echo would stay valid.
  it('applies the echo of its own invalidation again, which costs a miss and never brings the old value back', async () => {
    const a = await start({ default: { store: 'SharedTier' } });
    await cache('default', a).set('k', 'old', TAGGED);
    const bump = sinon.spy(SharedTier.store, 'bump');
    wire.hold();
    await cache('default', a).invalidate(['any:t']);
    expect(await cache('default', a).get('k')).to.eq(undefined);
    await cache('default', a).set('k', 'between', TAGGED);
    await wire.deliver();
    await drain();
    expect([bump.callCount, await cache('default', a).get('k')]).to.deep.eq([2, undefined]);
    expect([await cache('default', a).wrap('k', TAGGED, async () => 'new'), await cache('default', a).get('k')]).to.deep.eq(['new', 'new']);
  });

  // Fails when dispose() does not unsubscribe: the bus would keep the disposed service reachable.
  it('stops applying deliveries once its container is disposed, and leaves no timer behind', async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    // The first boot in a process starts one framework timer that outlives every app; it is not counted.
    await (await startProcess({ default: {} })).dispose();
    const before = timers();
    const unsubscribe = sinon.stub();
    const subscribe = sinon.stub(wire, 'subscribe').callsFake((fn: (bumps: readonly TagBump[]) => void) => unsubscribe.callsFake(subscribe.wrappedMethod.call(wire, fn)));
    const app = await startProcess({ default: { store: 'SharedTier' } });
    await cache('default', app.container).get('k');
    const bump = sinon.spy(SharedTier.store, 'bump');
    await app.dispose();
    await wire.send(stampBumps(['any:t']));
    await drain();
    expect([bump.callCount, timers() - before, unsubscribe.calledOnce]).to.deep.eq([0, 0, true]);
  });

  // Fails when a bus message carries more than tags and stamps.
  it('sends tags and stamps only, never a key, a value or a scope segment', async () => {
    const a = await start(SHARED, (container) => container.register(SecretScope).as(CacheScope));
    await cache('shared', a).set('customer-key', 'value-secret', TAGGED);
    await cache('shared', a).invalidate(['any:t']);
    expect(wire.sent.flat().map((bump) => Object.keys(bump).sort())).to.deep.eq([['tag', 'version']]);
    const carried = JSON.stringify(wire.sent);
    for (const secret of ['customer-key', 'value-secret', 'tenant-secret']) expect(carried).to.not.contain(secret);
  });
});

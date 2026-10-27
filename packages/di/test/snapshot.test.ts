import 'mocha';
import { expect } from 'chai';
import { AsyncService, Autoinject, Container, DI, LazyInject, PerInstanceCheck, RestoreIncomplete, SyncService } from '../src/index.js';
import type { Class, ContainerSnapshot, IInstanceCheck } from '../src/index.js';

class Base {}
class Impl extends Base {}
class Kept {}
class Svc extends AsyncService {
  public disposed = false;
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

async function capturedWarnings(run: () => Promise<void>): Promise<unknown[]> {
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return warnings;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expectSnapshotState(c: Container, before: ContainerSnapshot) {
  const now = c.snapshot();
  expect([...now.cache.keys()]).to.deep.equal([...before.cache.keys()]);
  for (const [key, list] of before.cache) {
    expect(now.cache.get(key)).to.have.ordered.members(list);
  }
  expect([...now.registry.keys()]).to.deep.equal([...before.registry.keys()]);
  expect([...now.values.keys()]).to.deep.equal([...before.values.keys()]);
}

async function restoreError(c: Container, before: ContainerSnapshot): Promise<Error | undefined> {
  return c.restore(before).then(
    () => undefined,
    (err: Error) => err,
  );
}

class Polled extends AsyncService {
  public static last: Polled | undefined;
  public static gate = () => wait(20);
  public disposed = false;
  public async resolve(): Promise<void> {
    Polled.last = this;
    await Polled.gate();
    await super.resolve();
  }
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

// Never cached, so a restore round finds nothing to dispose after it.
class FailingQuick extends AsyncService {
  public async resolve(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    throw new Error('refused');
  }
}

let classCount = 0;
// A distinct name per class: the cache tracks resolutions in flight by type name.
function named<T extends object>(base: new () => T): Class<T> {
  const cls = class extends base {};
  Object.defineProperty(cls, 'name', { value: `${base.name}${++classCount}` });
  return cls;
}

describe('container snapshot / restore', () => {
  it('restore drops registrations, values, singletons and listeners made after the snapshot and disposes the services', async () => {
    const c = new Container();
    c.register(Kept).asSelf();
    const kept = c.resolve(Kept);
    const before = c.snapshot();

    c.register(Impl).as(Base);
    c.register({ x: 1 }).asValue('__x__');
    const svc = await c.resolve(Svc);
    const listener = () => undefined;
    c.on('ev', listener);
    const child = c.child();

    await c.restore(before);

    expect(c.hasRegistered(Base)).to.be.false;
    expect(c.get('__x__')).to.be.undefined;
    expect(c.Cache.has(Svc)).to.be.false;
    expect(svc.disposed).to.be.true;
    expect(c.listenerCount('ev')).to.equal(0);
    expect(c.getCacheStats().childrenCount).to.equal(0);
    expect(c.getCacheStats().size).to.equal(before.cache.size);
    expect(child.getCacheStats().size).to.equal(1);
    expect(c.resolve(Kept)).to.equal(kept);
  });

  it('restore keeps a listener and a value that existed before the snapshot', async () => {
    const c = new Container();
    const listener = () => undefined;
    c.on('ev', listener);
    c.register({ a: 1 }).asValue('__a__');
    const before = c.snapshot();
    c.on('ev', () => undefined);
    await c.restore(before);
    expect(c.rawListeners('ev')).to.deep.equal([listener]);
    expect(c.get('__a__')).to.deep.equal({ a: 1 });
  });

  it('restore removes a second copy of a listener added after the snapshot', async () => {
    const c = new Container();
    const listener = () => undefined;
    c.on('ev', listener);
    const before = c.snapshot();
    c.on('ev', listener);
    await c.restore(before);
    expect(c.rawListeners('ev')).to.deep.equal([listener]);
  });

  it('restore puts back a registration list changed after the snapshot', async () => {
    const c = new Container();
    c.register(Impl).as(Base);
    const before = c.snapshot();
    c.unregister(Impl);
    c.register(Kept).as(Base);
    await c.restore(before);
    expect(c.getRegisteredTypes(Base)).to.deep.equal([Impl]);
  });

  it('a snapshot is not changed by later registrations', () => {
    const c = new Container();
    const before = c.snapshot();
    c.register(Impl).as(Base);
    expect(before.registry.has('Base')).to.be.false;
  });

  it('DI.snapshot / DI.restore act on the root container', async () => {
    const before = DI.snapshot();
    DI.register({ y: 1 }).asValue('__snapshot_root__');
    await DI.restore(before);
    expect(DI.get('__snapshot_root__')).to.be.undefined;
  });

  it('restore puts the entries of a value map back into the same Map', async () => {
    const c = new Container();
    const local = { name: 'local' };
    c.register(local).asMapValue('__file_provider_instance__', 'local');
    const map = c.get<Map<string, unknown>>('__file_provider_instance__');
    const before = c.snapshot();

    c.register({ name: 'temp' }).asMapValue('__file_provider_instance__', 'temp');
    c.register({ name: 'other local' }).asMapValue('__file_provider_instance__', 'local');
    await c.restore(before);

    const restored = c.get<Map<string, unknown>>('__file_provider_instance__');
    expect(restored).to.equal(map);
    expect([...restored.keys()]).to.deep.equal(['local']);
    expect(restored.get('local')).to.equal(local);
  });

  it('restore waits for a resolve in flight and disposes what it built', async () => {
    class Slow extends AsyncService {
      public disposed = false;
      public async resolve(): Promise<void> {
        await new Promise((r) => setTimeout(r, 20));
        await super.resolve();
      }
      public async dispose(): Promise<void> {
        this.disposed = true;
      }
    }

    const c = new Container();
    const before = c.snapshot();
    const pending = c.resolve(Slow);
    await c.restore(before);
    const slow = await pending;

    expect(slow.disposed).to.be.true;
    expect(c.Cache.has(Slow)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore also drops and disposes what a disposing service resolved', async () => {
    class Late extends AsyncService {
      public disposed = false;
      public async dispose(): Promise<void> {
        this.disposed = true;
      }
    }

    let late: Late | undefined;
    const c = new Container();
    class Leaky extends AsyncService {
      public async dispose(): Promise<void> {
        late = await c.resolve(Late);
      }
    }

    const before = c.snapshot();
    await c.resolve(Leaky);
    await c.restore(before);

    expect(late).to.be.instanceOf(Late);
    expect(late!.disposed).to.be.true;
    expect(c.Cache.has(Late)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore disposes against the state the services were created in, then swaps it back', async () => {
    const c = new Container();
    let registeredDuringDispose: boolean | undefined;
    class Checking extends AsyncService {
      public async dispose(): Promise<void> {
        registeredDuringDispose = c.hasRegistered(Base);
      }
    }

    const before = c.snapshot();
    c.register(Impl).as(Base);
    await c.resolve(Checking);
    await c.restore(before);

    expect(registeredDuringDispose).to.be.true;
    expect(c.hasRegistered(Base)).to.be.false;
  });

  it('a dispose() reads a value, a lazy injection and a registration made after the snapshot without failing', async () => {
    class Settings {
      public port = 8080;
    }
    class Reader extends AsyncService {
      @LazyInject(Settings)
      public Settings: Settings;

      public read: unknown[] = [];

      public async dispose(): Promise<void> {
        this.read.push(c.get<{ port: number }>('__restore_cfg__').port, this.Settings.port, c.resolve(Base));
      }
    }

    const c = new Container();
    const before = c.snapshot();
    c.register({ port: 3000 }).asValue('__restore_cfg__');
    c.register(Settings).asSelf();
    c.register(Impl).as(Base);
    const reader = await c.resolve(Reader);

    const warnings = await capturedWarnings(() => c.restore(before));

    expect(warnings).to.deep.equal([]);
    expect(reader.read[0]).to.equal(3000);
    expect(reader.read[1]).to.equal(8080);
    expect(reader.read[2]).to.be.instanceOf(Impl);
  });

  it('what a dispose() resolves or registers does not survive the restore', async () => {
    class Late extends AsyncService {
      public disposals = 0;
      public async dispose(): Promise<void> {
        this.disposals++;
      }
    }

    let late: Late | undefined;
    let impl: unknown;
    const c = new Container();
    class Leaky extends AsyncService {
      public disposals = 0;
      public async dispose(): Promise<void> {
        this.disposals++;
        impl = c.resolve(Base);
        late = await c.resolve(Late);
        c.register({ leaked: true }).asValue('__leaked__');
        c.register(Kept).asSelf();
      }
    }

    const before = c.snapshot();
    c.register(Impl).as(Base);
    const leaky = await c.resolve(Leaky);
    await c.restore(before);

    expect(impl).to.be.instanceOf(Impl);
    expect(c.Cache.has(Impl)).to.be.false;
    expect(c.Cache.has(Late)).to.be.false;
    expect(c.get('__leaked__')).to.be.undefined;
    expect(c.hasRegistered(Kept)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
    expect(leaky.disposals).to.equal(1);
    expect(late!.disposals).to.equal(1);
  });

  it('restore settles and disposes a resolve that a dispose() starts without awaiting', async () => {
    class Slow extends AsyncService {
      public disposed = false;
      public async resolve(): Promise<void> {
        await new Promise((r) => setTimeout(r, 20));
        await super.resolve();
      }
      public async dispose(): Promise<void> {
        this.disposed = true;
      }
    }

    let pending: Promise<Slow> | undefined;
    const c = new Container();
    class Starter extends AsyncService {
      public async dispose(): Promise<void> {
        pending = c.resolve(Slow);
      }
    }

    const before = c.snapshot();
    await c.resolve(Starter);
    await c.restore(before);
    const slow = await pending!;

    expect(slow.disposed).to.be.true;
    expect(c.Cache.has(Slow)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore disposes in reverse resolution order and leaves services from before the snapshot alone', async () => {
    const order: string[] = [];
    class Old extends AsyncService {
      public async dispose(): Promise<void> {
        order.push('old');
      }
    }
    class Early extends AsyncService {
      public async dispose(): Promise<void> {
        order.push('early');
      }
    }
    class Later extends AsyncService {
      public async dispose(): Promise<void> {
        order.push('later');
      }
    }

    const c = new Container();
    await c.resolve(Old);
    const before = c.snapshot();
    await c.resolve(Early);
    await c.resolve(Later);
    await c.restore(before);

    expect(order).to.deep.equal(['later', 'early']);
    expect(c.Cache.has(Old)).to.be.true;
  });

  it('restore disposes three generations of services resolved while disposing', async () => {
    const c = new Container();
    const disposed: string[] = [];
    class Third extends AsyncService {
      public async dispose(): Promise<void> {
        disposed.push('third');
      }
    }
    class Second extends AsyncService {
      public async dispose(): Promise<void> {
        disposed.push('second');
        await c.resolve(Third);
      }
    }
    class First extends AsyncService {
      public async dispose(): Promise<void> {
        disposed.push('first');
        await c.resolve(Second);
      }
    }

    const before = c.snapshot();
    await c.resolve(First);
    await c.restore(before);

    expect(disposed).to.deep.equal(['first', 'second', 'third']);
    expect(c.Cache.has(Third)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore gives up after five nested generations, still swaps back, and rejects naming the cap and the dropped services', async () => {
    const c = new Container();
    class Link extends AsyncService {
      public async dispose(): Promise<void> {
        await c.resolve(named(Link));
      }
    }

    const before = c.snapshot();
    await c.resolve(named(Link));
    let error: Error | undefined;
    await capturedWarnings(async () => {
      await c.restore(before).catch((e: Error) => (error = e));
    });

    expect(error).to.be.instanceOf(RestoreIncomplete);
    expect(error?.message).to.include('5 generations');
    expect(error?.message).to.match(/Dropped without dispose\(\): Link[0-9]+/);
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore disposes a service built during another dispose() before the older services still waiting', async () => {
    const order: string[] = [];
    class Orm extends AsyncService {
      public closed = false;
      public async dispose(): Promise<void> {
        this.closed = true;
        order.push('orm');
      }
    }
    class Queue extends SyncService {
      @Autoinject(Orm)
      public Orm: Orm;

      public async dispose(): Promise<void> {
        order.push(this.Orm.closed ? 'queue after orm' : 'queue');
      }
    }
    class Scheduler extends AsyncService {
      @LazyInject(Queue)
      public Queue: Queue;

      public async dispose(): Promise<void> {
        order.push('scheduler');
        expect(this.Queue).to.be.instanceOf(Queue);
      }
    }

    const c = new Container();
    const before = c.snapshot();
    await c.resolve(Orm);
    await c.resolve(Scheduler);
    await c.restore(before);

    expect(order).to.deep.equal(['scheduler', 'queue', 'orm']);
    expect(c.Cache.has(Queue)).to.be.false;
  });

  it('a resolve started after the last settle() is settled and disposed before the swap', async () => {
    class Slow extends AsyncService {
      public disposed = false;
      public async resolve(): Promise<void> {
        await new Promise((r) => setTimeout(r, 20));
        await super.resolve();
      }
      public async dispose(): Promise<void> {
        this.disposed = true;
      }
    }

    const c = new Container();
    const before = c.snapshot();
    const settle = c.Cache.settle.bind(c.Cache);
    let pending: Promise<Slow> | undefined;
    c.Cache.settle = async (passes?: number) => {
      const done = await settle(passes);
      pending ??= c.resolve(Slow);
      return done;
    };

    await c.restore(before);
    const slow = await pending!;

    expect(slow.disposed).to.be.true;
    expect(c.Cache.has(Slow)).to.be.false;
    expect(c.getCacheStats().size).to.equal(before.cache.size);
  });

  it('restore keeps the children that existed before the snapshot and disposes the newer ones', async () => {
    const c = new Container();
    const older = c.child();
    const olderSvc = await older.resolve(Svc);
    const before = c.snapshot();
    const newer = c.child();
    const newerSvc = await newer.resolve(Svc);

    await c.restore(before);

    expect(olderSvc.disposed).to.be.false;
    expect(newerSvc.disposed).to.be.true;
    expect(c.getCacheStats().childrenCount).to.equal(1);
    expect(older.get(Svc)).to.equal(olderSvc);
  });

  it('a listener a dispose() adds does not survive the restore', async () => {
    const c = new Container();
    class Listening extends AsyncService {
      public async dispose(): Promise<void> {
        c.on('ev', () => undefined);
      }
    }

    const before = c.snapshot();
    await c.resolve(Listening);
    await c.restore(before);

    expect(c.listenerCount('ev')).to.equal(0);
  });

  it('a dispose() that edits a value map from the snapshot leaves the same Map with the snapshot entries', async () => {
    const c = new Container();
    const local = { name: 'local' };
    c.register(local).asMapValue('__restore_map__', 'local');
    const map = c.get<Map<string, unknown>>('__restore_map__');
    class Unpublishing extends AsyncService {
      public async dispose(): Promise<void> {
        map.delete('local');
        map.set('temp', { name: 'temp' });
      }
    }

    const before = c.snapshot();
    await c.resolve(Unpublishing);
    await c.restore(before);

    const restored = c.get<Map<string, unknown>>('__restore_map__');
    expect(restored).to.equal(map);
    expect([...restored]).to.deep.equal([['local', local]]);
  });

  it('a dispose() that resolves a service disposed before it gets the disposed instance, not a new one', async () => {
    class Newer extends AsyncService {
      public disposals = 0;
      public async dispose(): Promise<void> {
        this.disposals++;
      }
    }
    const c = new Container();
    let seen: Newer | undefined;
    class Older extends AsyncService {
      public async dispose(): Promise<void> {
        seen = await c.resolve(Newer);
      }
    }

    const before = c.snapshot();
    await c.resolve(Older);
    const newer = await c.resolve(Newer);
    await c.restore(before);

    expect(seen).to.equal(newer);
    expect(newer.disposals).to.equal(1);
  });

  describe('when resolutions keep starting during disposal', () => {
    let poll: ReturnType<typeof setInterval> | undefined;
    let gates: (() => void)[] = [];
    const openGates = () => gates.splice(0).forEach((open) => open());
    afterEach(() => {
      clearInterval(poll);
      Polled.gate = () => wait(20);
      openGates();
    });

    it('restore gives up when a dispose() keeps starting resolutions, names them and still restores the snapshot', async () => {
      const c = new Container();
      c.register(Kept).asSelf();
      c.resolve(Kept);
      const polled: Promise<Polled>[] = [];
      // Each resolve finishes only once the next tick has started another, so one is always in flight whatever the timer jitter.
      Polled.gate = () => new Promise<void>((open) => gates.push(open));
      class Poller extends AsyncService {
        public async dispose(): Promise<void> {
          const tick = () => {
            const previous = gates.splice(0);
            polled.push(c.resolve(named(Polled)));
            previous.forEach((open) => open());
          };
          tick();
          poll = setInterval(tick, 5);
        }
      }

      const before = c.snapshot();
      await c.resolve(Poller);
      const error = await restoreError(c, before);
      clearInterval(poll);
      openGates();

      expect(error?.constructor.name).to.equal('RestoreIncomplete');
      expect(error?.message).to.match(/settle passes/);
      expect(error?.message).to.match(/Still resolving: Polled\d+/);
      expectSnapshotState(c, before);

      const settled = await Promise.allSettled(polled);
      expectSnapshotState(c, before);
      const built = settled.filter((r): r is PromiseFulfilledResult<Polled> => r.status === 'fulfilled').map((r) => r.value);
      expect(built.every((p) => p.disposed)).to.be.true;
      expect(settled.some((r) => r.status === 'rejected' && /finished resolving after the container was restored/.test(String(r.reason)))).to.be.true;
      expect(Polled.last?.disposed).to.be.true;
    });

    it('restore gives up on a reconnect loop that resolves a failing connection again as soon as it fails', async () => {
      class Connection extends AsyncService {
        public async resolve(): Promise<void> {
          await wait(2);
          throw new Error('connection refused');
        }
      }
      const c = new Container();
      let reconnecting = true;
      const connect = (): void => {
        c.resolve(Connection).catch(() => reconnecting && connect());
      };
      class Client extends AsyncService {
        public async dispose(): Promise<void> {
          connect();
        }
      }

      const before = c.snapshot();
      await c.resolve(Client);
      try {
        const error = await restoreError(c, before);
        expect(error?.constructor.name).to.equal('RestoreIncomplete');
        expect(error?.message).to.match(/Still resolving: Connection/);
        expectSnapshotState(c, before);
      } finally {
        reconnecting = false;
      }
      await wait(20);
    });

    it('restore gives up after its round cap when every round leaves a new resolution in flight', async () => {
      const c = new Container();
      const settle = c.Cache.settle.bind(c.Cache);
      const started: Promise<FailingQuick>[] = [];
      c.Cache.settle = async (passes?: number) => {
        const done = await settle(passes);
        const attempt = c.resolve(named(FailingQuick));
        attempt.catch(() => undefined);
        started.push(attempt);
        return done;
      };

      const before = c.snapshot();
      let error: Error | undefined;
      await capturedWarnings(async () => {
        error = await restoreError(c, before);
      });

      expect(error?.constructor.name).to.equal('RestoreIncomplete');
      expect(error?.message).to.match(/10 rounds/);
      expect(error?.message).to.match(/Still resolving: FailingQuick[0-9]+/);
      await Promise.allSettled(started);
      expectSnapshotState(c, before);
    });
  });

  it('a resolution that finishes after the cache was restored is disposed and rejected, not cached', async () => {
    class Late extends Polled {}
    const c = new Container();
    const before = c.snapshot();
    let emitted = false;
    c.on('di.resolved.Late', () => (emitted = true));

    const pending = c.resolve(Late);
    const late = Polled.last;
    c.Cache.restoreState(before.cache);
    const error = await pending.then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error?.message).to.match(/Late finished resolving after the container was restored/);
    expect(late).to.be.instanceOf(Late);
    expect(late?.disposed).to.be.true;
    expect(c.Cache.has(Late)).to.be.false;
    expect(emitted).to.be.false;
  });

  it('a per-instance-check resolution that finishes after the cache was restored is disposed and rejected, not cached', async () => {
    @PerInstanceCheck()
    class Named extends Polled implements IInstanceCheck {
      constructor(public Name: string) {
        super();
      }
      __checkInstance__(options: unknown[]): boolean {
        return this.Name === options[0];
      }
    }
    const c = new Container();
    const before = c.snapshot();

    const pending = c.resolve(Named, ['a']);
    const late = Polled.last;
    c.Cache.restoreState(before.cache);
    const error = await pending.then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error?.message).to.match(/Named finished resolving after the container was restored/);
    expect(late?.disposed).to.be.true;
    expect(c.Cache.has(Named)).to.be.false;
  });
});

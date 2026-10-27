import 'mocha';
import { expect } from 'chai';
import { AsyncService, Container, DI, LazyInject } from '../src/index.js';
import type { Class } from '../src/index.js';

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

  it('restore keeps passing until a pass drops nothing: three generations of services resolved while disposing', async () => {
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

  it('restore gives up after five passes, warns, and still leaves the cache as it was', async () => {
    const c = new Container();
    const link = (): Class<AsyncService> =>
      class extends AsyncService {
        public async dispose(): Promise<void> {
          await c.resolve(link());
        }
      };

    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      const before = c.snapshot();
      await c.resolve(link());
      await c.restore(before);
      expect(c.getCacheStats().size).to.equal(before.cache.size);
    } finally {
      console.warn = warn;
    }

    expect(warnings.some((w) => String(w).includes('5 passes'))).to.be.true;
  });
});

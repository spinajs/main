import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable, AsyncService } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration-common';
import { createTestApp, disposeTestApps } from '../src/index.js';

// Registry entries, values and cache keys of the root container, comparable with deep.equal.
function rootState() {
  const snapshot = DI.RootContainer.snapshot();
  return {
    registry: [...snapshot.registry].map(([k, v]) => [k, [...v]]),
    values: [...snapshot.values].map(([k, v]) => [k, [...v]]),
    cache: [...DI.RootContainer.getCacheStats().entries].sort(),
  };
}


@Injectable(Bootstrapper)
class SpecBootstrapper extends Bootstrapper {
  public static Runs = 0;
  public bootstrap(): void {
    SpecBootstrapper.Runs++;
  }
}

class SpecService extends AsyncService {
  public disposed = false;
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class ConfiguredService extends AsyncService {
  @Config('spec.port')
  protected Port: number;

  public portAtDispose: number | undefined;

  public async dispose(): Promise<void> {
    this.portAtDispose = this.Port;
  }
}

// dispose() starts a reconnect loop that resolves a failing connection again as soon as it fails.
function reconnecting() {
  const loop = { running: true };
  class Connection extends AsyncService {
    public async resolve(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error('connection refused');
    }
  }
  class Client extends AsyncService {
    public async dispose(): Promise<void> {
      const connect = (): void => {
        DI.resolve(Connection).catch(() => loop.running && connect());
      };
      connect();
    }
  }
  return { loop, Client };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createTestApp (root scope)', () => {
  afterEach(disposeTestApps);

  it('boots a Configuration from a plain object and restores root on dispose', async () => {
    const baseline = DI.RootContainer.getCacheStats().size;
    const app = await createTestApp({ config: { app: { name: 'a' } } });
    expect(app.config.get('app.name')).to.equal('a');
    expect(DI.get(Configuration)).to.equal(app.config);
    await app.dispose();
    expect(DI.RootContainer.getCacheStats().size).to.equal(baseline);
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });

  it('config of one app is invisible to the next', async () => {
    const a = await createTestApp({ config: { onlyA: { k: 1 } } });
    expect(a.config.get('onlyA.k')).to.equal(1);
    await a.dispose();
    const b = await createTestApp({ config: { onlyB: { k: 2 } } });
    expect(b.config).to.not.equal(a.config);
    expect(b.config.get('onlyA.k')).to.be.undefined;
    expect(b.config.get('onlyB.k')).to.equal(2);
    expect(DI.get(Configuration)).to.equal(b.config);
    await b.dispose();
  });

  it('restores the Configuration registration and the schema values on dispose', async () => {
    const before = rootState();
    const app = await createTestApp({
      schemas: [{ $id: 'spec/r', $configurationModule: 'r', type: 'object' }],
      config: { r: {} },
    });
    const during = rootState();
    expect(during.values).to.not.deep.equal(before.values);
    expect(during.registry).to.not.deep.equal(before.registry);
    await app.dispose();
    const after = rootState();
    expect(after.values).to.deep.equal(before.values);
    expect(after.registry).to.deep.equal(before.registry);
    expect(after.cache).to.deep.equal(before.cache);
  });

  it('does not hand a singleton resolved in one app to the next', async () => {
    const register = (c: IContainer) => c.register(SpecService).asSelf();
    const a = await createTestApp({ config: {}, register });
    const svcA = await a.resolve(SpecService);
    expect(await a.resolve(SpecService)).to.equal(svcA);
    await a.dispose();
    const b = await createTestApp({ config: {}, register });
    const svcB = await b.resolve(SpecService);
    expect(svcB).to.not.equal(svcA);
    await b.dispose();
  });

  it('accepts schemas typed as IConfigurationSchema', async () => {
    const typed: IConfigurationSchema = { $configurationModule: 't' };
    const app = await createTestApp({ schemas: [typed], config: {} });
    await app.dispose();
  });

  it('refuses a second live root app and leaves the first one untouched', async () => {
    const before = rootState();
    const a = await createTestApp({ config: { app: { name: 'a' } }, register: (c) => c.register(SpecService).asSelf(), resolve: [SpecService] });
    const during = rootState();
    let error: Error | undefined;
    await createTestApp({ config: { app: { name: 'b' } } }).catch((e: Error) => (error = e));
    expect(error?.message).to.match(/a root app is already live/);
    expect(rootState()).to.deep.equal(during);
    expect(a.config.get('app.name')).to.equal('a');
    await a.dispose();
    expect(rootState()).to.deep.equal(before);
  });

  it('runs bootstrappers, registers schemas and validates the config against them', async () => {
    const runs = SpecBootstrapper.Runs;
    const app = await createTestApp({
      schemas: [{ $id: 'spec/x', $configurationModule: 'x', type: 'object', properties: { n: { type: 'number' } } }],
      config: { x: { n: 1 } },
    });
    expect(SpecBootstrapper.Runs).to.equal(runs + 1);
    expect(app.config.get('x.n')).to.equal(1);
    await app.dispose();
  });

  it('applies register() before resolving and disposes services it created', async () => {
    const app = await createTestApp({
      config: {},
      register: (c) => c.register(SpecService).asSelf(),
      resolve: [SpecService],
    });
    const svc = DI.get(SpecService)!;
    expect(svc).to.be.instanceOf(SpecService);
    await app.dispose();
    expect(svc.disposed).to.be.true;
    expect(DI.RootContainer.hasRegistered(SpecService)).to.be.false;
  });

  it('a service whose dispose() reads a @Config property disposes without a failure', async () => {
    const app = await createTestApp({
      config: { spec: { port: 4321 } },
      register: (c) => c.register(ConfiguredService).asSelf(),
      resolve: [ConfiguredService],
    });
    const svc = DI.get(ConfiguredService)!;

    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      await app.dispose();
    } finally {
      console.warn = warn;
    }

    expect(warnings).to.deep.equal([]);
    expect(svc.portAtDispose).to.equal(4321);
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });

  it('restores root exactly when the boot fails with a validation error', async () => {
    const before = rootState();
    let error: Error | undefined;
    try {
      await createTestApp({
        schemas: [{ $id: 'spec/y', $configurationModule: 'y', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }],
        config: { y: {} },
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'boot should have failed').to.be.instanceOf(Error);
    expect(error!.constructor.name).to.equal('InvalidConfiguration');
    expect(error!.message).to.include('schema spec/y');
    expect(rootState()).to.deep.equal(before);
  });

  it('dispose rejects with the restore error when resolutions keep starting, and still restores root', async () => {
    const { loop, Client } = reconnecting();
    const before = rootState();
    const app = await createTestApp({ config: {}, register: (c) => c.register(Client).asSelf(), resolve: [Client] });
    let error: Error | undefined;
    try {
      await app.dispose().catch((e: Error) => (error = e));
    } finally {
      loop.running = false;
    }

    expect(error?.constructor.name).to.equal('RestoreIncomplete');
    expect(error?.message).to.match(/Still resolving: Connection/);
    expect(rootState()).to.deep.equal(before);
  });

  it('disposeTestApps disposes every app before it rethrows a restore error', async () => {
    const { loop, Client } = reconnecting();
    const child = await createTestApp({ scope: 'child', config: {}, register: (c) => c.register(SpecService).asSelf(), resolve: [SpecService] });
    const svc = await child.resolve(SpecService);
    await createTestApp({ config: {}, register: (c) => c.register(Client).asSelf(), resolve: [Client] });
    let error: Error | undefined;
    try {
      await disposeTestApps().catch((e: Error) => (error = e));
    } finally {
      loop.running = false;
    }

    expect(error?.constructor.name).to.equal('RestoreIncomplete');
    expect(svc.disposed).to.be.true;
  });

  describe('a boot that does not finish', () => {
    it('bootTimeout rejects a boot that never resolves, frees the slot and restores root', async () => {
      const before = rootState();
      let error: Error | undefined;
      await createTestApp({ config: {}, bootTimeout: 30, register: () => new Promise(() => undefined) }).catch((e: Error) => (error = e));

      expect(error?.message).to.match(/did not finish booting within 30 ms/);
      expect(rootState()).to.deep.equal(before);

      const next = await createTestApp({ config: { n: { k: 1 } } });
      expect(next.config.get('n.k')).to.equal(1);
      await next.dispose();
      expect(rootState()).to.deep.equal(before);
    });

    it('bootTimeout does not wait for a resolution that hangs, and disposes it when it finally finishes', async () => {
      const gate = deferred();
      let late: HangingService | undefined;
      class HangingService extends AsyncService {
        public disposed = false;
        public async resolve(): Promise<void> {
          late = this;
          await gate.promise;
        }
        public async dispose(): Promise<void> {
          this.disposed = true;
        }
      }
      const before = rootState();
      let error: Error | undefined;
      await createTestApp({ config: {}, bootTimeout: 30, register: (c) => c.register(HangingService).asSelf(), resolve: [HangingService] }).catch(
        (e: Error) => (error = e),
      );
      expect(error?.message).to.match(/did not finish booting/);
      expect(rootState()).to.deep.equal(before);

      gate.release();
      await tick();
      expect(late?.disposed).to.be.true;
      expect(rootState()).to.deep.equal(before);
    });

    it('a boot that finishes after its timeout registers nothing and does not keep the slot', async () => {
      const gate = deferred();
      const runs = SpecBootstrapper.Runs;
      const before = rootState();
      let afterGate = false;
      const stuck = createTestApp({
        config: {},
        bootTimeout: 30,
        register: async (c) => {
          c.register(SpecService).asSelf();
          await gate.promise;
          afterGate = true;
        },
        resolve: [SpecService],
      }).catch((e: Error) => e);
      expect(await stuck).to.be.instanceOf(Error);

      gate.release();
      await tick();
      expect(afterGate).to.be.true;
      expect(SpecBootstrapper.Runs).to.equal(runs);
      expect(rootState()).to.deep.equal(before);

      const next = await createTestApp({ config: { n: { k: 2 } } });
      expect(next.config.get('n.k')).to.equal(2);
      expect(DI.RootContainer.hasRegistered(SpecService)).to.be.false;
      expect(DI.RootContainer.isResolved(SpecService)).to.be.false;
      await next.dispose();
      expect(rootState()).to.deep.equal(before);
    });

    it('a second root create fails fast while the first one is still booting', async () => {
      const gate = deferred();
      const before = rootState();
      const first = createTestApp({ name: 'slow-suite', config: {}, bootTimeout: 5000, register: () => gate.promise });

      let error: Error | undefined;
      await createTestApp({ config: {} }).catch((e: Error) => (error = e));
      gate.release();
      const app = await first;
      expect(error?.message).to.match(/"slow-suite" \(booting, started \d+ ms ago\) is still booting/);
      expect(app.config).to.be.instanceOf(Configuration);
      await app.dispose();
      expect(rootState()).to.deep.equal(before);
    });

    it('a root create while the previous app is still disposing fails fast', async () => {
      const gate = deferred();
      class SlowDispose extends AsyncService {
        public async dispose(): Promise<void> {
          await gate.promise;
        }
      }
      const app = await createTestApp({ config: {}, register: (c) => c.register(SlowDispose).asSelf(), resolve: [SlowDispose] });
      const disposing = app.dispose();
      await tick();

      let error: Error | undefined;
      await createTestApp({ config: {} }).catch((e: Error) => (error = e));
      expect(error?.message).to.match(/still being disposed/);

      gate.release();
      await disposing;
      await (await createTestApp({ config: {} })).dispose();
    });
  });

  it('dispose is idempotent', async () => {
    const app = await createTestApp({ config: {} });
    await app.dispose();
    await app.dispose();
  });
});

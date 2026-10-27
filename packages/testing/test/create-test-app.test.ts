import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable, AsyncService } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
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

  it('throws on out-of-order dispose of root apps and restores nothing', async () => {
    const before = rootState();
    const a = await createTestApp({ config: {} });
    const b = await createTestApp({ config: {}, register: (c) => c.register(SpecService).asSelf(), resolve: [SpecService] });
    const during = rootState();
    let error: Error | undefined;
    await a.dispose().catch((e: Error) => (error = e));
    expect(error?.message).to.match(/reverse creation order/);
    expect(rootState()).to.deep.equal(during);
    expect(DI.RootContainer.hasRegistered(SpecService)).to.be.true;
    await b.dispose();
    expect(DI.RootContainer.hasRegistered(SpecService)).to.be.false;
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

  it('dispose is idempotent', async () => {
    const app = await createTestApp({ config: {} });
    await app.dispose();
    await app.dispose();
  });
});

import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable, AsyncService } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { createTestApp } from '../src/index.js';

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
  it('boots a Configuration from a plain object and restores root on dispose', async () => {
    const baseline = DI.RootContainer.getCacheStats().size;
    const app = await createTestApp({ config: { app: { name: 'a' } } });
    expect(app.config.get('app.name')).to.equal('a');
    expect(DI.get(Configuration)).to.equal(app.config);
    await app.dispose();
    expect(DI.RootContainer.getCacheStats().size).to.equal(baseline);
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });

  it('two apps created one after another do not share configuration', async () => {
    const a = await createTestApp({ config: { app: { name: 'a' } } });
    expect(a.config.get('app.name')).to.equal('a');
    await a.dispose();
    const b = await createTestApp({ config: { app: { name: 'b' } } });
    expect(b.config.get('app.name')).to.equal('b');
    expect(DI.get(Configuration)!.get('app.name')).to.equal('b');
    await b.dispose();
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

  it('restores root when the boot fails', async () => {
    const baseline = DI.RootContainer.getCacheStats().size;
    let failed = false;
    try {
      await createTestApp({
        schemas: [{ $id: 'spec/y', $configurationModule: 'y', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }],
        config: { y: {} },
      });
    } catch {
      failed = true;
    }
    expect(failed).to.be.true;
    expect(DI.RootContainer.getCacheStats().size).to.equal(baseline);
  });

  it('dispose is idempotent', async () => {
    const app = await createTestApp({ config: {} });
    await app.dispose();
    await app.dispose();
  });
});

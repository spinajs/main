import 'mocha';
import { expect } from 'chai';
import { DI, AsyncService } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { createTestApp, disposeTestApps } from '../src/index.js';

class ChildSvc extends AsyncService {
  public disposed = false;
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe('createTestApp (child scope)', () => {
  afterEach(disposeTestApps);

  it('two child apps live side by side with their own configuration', async () => {
    const a = await createTestApp({ scope: 'child', bootstrap: false, config: { app: { name: 'a' } } });
    const b = await createTestApp({ scope: 'child', bootstrap: false, config: { app: { name: 'b' } } });
    expect(a.config.get('app.name')).to.equal('a');
    expect(b.config.get('app.name')).to.equal('b');
    expect(a.container).to.not.equal(b.container);
    expect(a.container.Parent).to.equal(DI.RootContainer);
    expect(DI.RootContainer.isResolved(Configuration, false)).to.be.false;
    await a.dispose();
    await b.dispose();
    expect(DI.RootContainer.getCacheStats().childrenCount).to.equal(0);
  });

  it('owns the singletons it resolves and disposes them', async () => {
    DI.register(ChildSvc).asSelf();
    try {
      const app = await createTestApp({ scope: 'child', bootstrap: false, config: {}, resolve: [ChildSvc] });
      const svc = app.container.get(ChildSvc)!;
      expect(DI.RootContainer.Cache.has(ChildSvc)).to.be.false;
      await app.dispose();
      expect(svc.disposed).to.be.true;
    } finally {
      DI.unregister(ChildSvc);
    }
  });

  it('a failed child boot leaves no child behind', async () => {
    const schema = { $id: 'spec/c', $configurationModule: 'c', type: 'object', required: ['n'] };
    let error: unknown;
    try {
      await createTestApp({ scope: 'child', bootstrap: false, schemas: [schema], config: { c: {} } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    expect(DI.RootContainer.getCacheStats().childrenCount).to.equal(0);
  });
});

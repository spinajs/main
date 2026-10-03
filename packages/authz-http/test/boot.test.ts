import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { DefaultAuthzService } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';

import { Access, AccessContributor, PrincipalMiddleware } from '../src/index.js';

@BasePath('root-routes')
class RootRoutes extends BaseController {
  @Get()
  @Access('file:read')
  public read() {
    return new Ok();
  }
}

describe('root domain boot', function () {
  this.timeout(30000);

  let installedHere = false;

  before(async () => {
    try {
      testHost.config();
    } catch {
      installedHere = true;
      await testHost.installHost();
    }
  });

  after(async () => {
    DI.unregister(RootRoutes);
    DI.uncache(RootRoutes);
    await DI.get(PrincipalMiddleware)?.dispose();
    DI.uncache(PrincipalMiddleware);
    await testHost.resetRoot();
    if (installedHere) await testHost.uninstallHost();
  });

  it('waits for the server to listen, so the boot refs include the controllers registered meanwhile (B02)', async () => {
    testHost.config().set(['authz', 'permissions'], { 'file:read': {} });
    const contribute = sinon.spy(AccessContributor.prototype, 'contribute');
    try {
      const middleware = (await DI.resolve(PrincipalMiddleware)) as PrincipalMiddleware;
      expect(DI.RootContainer.Cache.has(DefaultAuthzService)).to.eq(false);

      // What http's Controllers does after the server resolved its middlewares.
      DI.register(RootRoutes).as(BaseController);
      DI.RootContainer.emit('http.server.listening');
      await (middleware as unknown as { rootService(): Promise<unknown> }).rootService();

      const root = contribute.getCalls().filter((c) => c.args[0] === 'root');
      expect(root).to.have.length(1);
      expect((root[0].returnValue as AuthzContribution).permissionRefs).to.deep.include({ permission: 'file:read', type: 'file', source: '@Access on RootRoutes.read' });
    } finally {
      contribute.restore();
      testHost.config().unset(['authz', 'permissions']);
    }
  });

  it('stops the http server when the root domain cannot boot', async () => {
    DI.uncache(PrincipalMiddleware);
    await testHost.resetRoot();
    // RootRoutes names file:read, which this config does not register: boot rule 7 fails.
    testHost.config().set(['authz', 'permissions'], {});
    try {
      const middleware = (await DI.resolve(PrincipalMiddleware)) as PrincipalMiddleware;
      const server = { stop: sinon.stub().resolves() };
      DI.RootContainer.emit('http.server.listening', server);

      const err = await (middleware as unknown as { rootService(): Promise<unknown> }).rootService().then(() => null, (e: unknown) => e);
      await new Promise((r) => setImmediate(r));

      expect(err).to.be.instanceOf(Error);
      expect(server.stop.calledOnce).to.eq(true);
    } finally {
      testHost.config().unset(['authz', 'permissions']);
    }
  });

  it('drops its listening hook when disposed', async () => {
    DI.uncache(PrincipalMiddleware);
    const before = DI.RootContainer.listenerCount('http.server.listening');
    const middleware = (await DI.resolve(PrincipalMiddleware)) as PrincipalMiddleware;
    expect(DI.RootContainer.listenerCount('http.server.listening')).to.eq(before + 1);
    await middleware.dispose();
    expect(DI.RootContainer.listenerCount('http.server.listening')).to.eq(before);
  });
});

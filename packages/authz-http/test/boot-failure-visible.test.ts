import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { AuthzConfigError } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';

import { Access, PrincipalMiddleware } from '../src/index.js';

@BasePath('boot-failure-guarded')
class GuardedRoutes extends BaseController {
  @Get()
  @Access('file:read')
  public read() {
    return new Ok();
  }
}

@BasePath('boot-failure-open')
class OpenRoutes extends BaseController {
  @Get()
  public list() {
    return new Ok();
  }
}

describe('a failed authz boot is visible to the process', function () {
  this.timeout(30000);

  let installedHere = false;
  let exitCode: typeof process.exitCode;
  let failed: sinon.SinonSpy;

  before(async () => {
    try {
      testHost.config();
    } catch {
      installedHere = true;
      await testHost.installHost();
    }
  });

  beforeEach(async () => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    failed = sinon.spy();
    DI.on('authz.boot.failed', failed);
    DI.uncache(PrincipalMiddleware);
    await testHost.resetRoot();
  });

  afterEach(async () => {
    process.exitCode = exitCode;
    DI.removeListener('authz.boot.failed', failed);
    DI.unregister(GuardedRoutes);
    DI.uncache(GuardedRoutes);
    DI.unregister(OpenRoutes);
    DI.uncache(OpenRoutes);
    await DI.get(PrincipalMiddleware)?.dispose();
    DI.uncache(PrincipalMiddleware);
    testHost.config().unset(['authz', 'permissions']);
    testHost.config().unset(['authz', 'http', 'unguardedRoutes']);
  });

  after(async () => {
    await testHost.resetRoot();
    if (installedHere) await testHost.uninstallHost();
  });

  async function listen() {
    const middleware = await DI.resolve(PrincipalMiddleware);
    const server = { stop: sinon.stub().resolves() };
    DI.RootContainer.emit('http.server.listening', server);
    const booted = await (middleware as unknown as { rootService(): Promise<unknown> }).rootService().then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((resolve) => setImmediate(resolve));
    return { server, booted };
  }

  it('sets exit code 1 and emits authz.boot.failed with the error when the root domain cannot boot', async () => {
    // GuardedRoutes names file:read, which this config does not register.
    testHost.config().set(['authz', 'permissions'], {});
    DI.register(GuardedRoutes).as(BaseController);

    const { server, booted } = await listen();

    expect(booted).to.be.instanceOf(Error);
    expect(process.exitCode).to.eq(1);
    expect(failed.calledOnce).to.eq(true);
    expect(failed.firstCall.args[0]).to.eq(booted);
    expect(server.stop.calledOnce).to.eq(true);
  });

  it('sets exit code 1 and emits authz.boot.failed when unguardedRoutes is throw and a route is unguarded', async () => {
    testHost.config().set(['authz', 'permissions'], { 'file:read': {} });
    testHost.config().set(['authz', 'http', 'unguardedRoutes'], 'throw');
    DI.register(OpenRoutes).as(BaseController);

    const { server } = await listen();

    expect(process.exitCode).to.eq(1);
    expect(failed.calledOnce).to.eq(true);
    expect(failed.firstCall.args[0]).to.be.instanceOf(AuthzConfigError);
    expect((failed.firstCall.args[0] as Error).message).to.include('OpenRoutes.list');
    expect(server.stop.calledOnce).to.eq(true);
  });

  it('leaves the exit code alone and emits nothing when the root domain boots', async () => {
    testHost.config().set(['authz', 'permissions'], { 'file:read': {} });
    DI.register(GuardedRoutes).as(BaseController);

    const { server, booted } = await listen();

    expect(booted).to.eq(null);
    expect(process.exitCode).to.eq(undefined);
    expect(failed.called).to.eq(false);
    expect(server.stop.called).to.eq(false);
  });
});

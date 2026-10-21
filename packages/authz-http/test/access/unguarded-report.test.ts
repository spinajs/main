import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthzConfigError } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy, Post } from '@spinajs/http';
import { bindConfiguration, bootConfiguration, testHost } from '@spinajs/authz-testing';

import { Access, AllowAnonymous, AUTHZ_HTTP_CONFIGURATION_SCHEMA, PrincipalMiddleware, UnguardedRoutesReport, findUnguardedRoutes } from '../../src/index.js';

class IsAuthenticated extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@BasePath('unguarded-open')
class OpenRoutes extends BaseController {
  @Get()
  public list() {
    return new Ok();
  }

  @Post()
  public create() {
    return new Ok();
  }
}

@BasePath('unguarded-method-level')
class MethodLevel extends BaseController {
  @Get('/a')
  @Access('file:read')
  public byAccess() {
    return new Ok();
  }

  @Get('/b')
  @Policy(IsAuthenticated)
  public byPolicy() {
    return new Ok();
  }

  @Get('/c')
  @AllowAnonymous()
  public byAnonymous() {
    return new Ok();
  }

  @Get('/d')
  public bare() {
    return new Ok();
  }
}

@BasePath('unguarded-class-access')
@Access('file:read')
class ClassAccess extends BaseController {
  @Get()
  public read() {
    return new Ok();
  }

  @Post()
  public write() {
    return new Ok();
  }
}

@BasePath('unguarded-class-policy')
@Policy(IsAuthenticated)
class ClassPolicy extends BaseController {
  @Get()
  public read() {
    return new Ok();
  }
}

@BasePath('unguarded-class-anonymous')
@AllowAnonymous()
class ClassAnonymous extends BaseController {
  @Get()
  public read() {
    return new Ok();
  }
}

class NoRoutes extends BaseController {
  public helper() {
    return 1;
  }
}

const GUARDED = [ClassAccess, ClassPolicy, ClassAnonymous, NoRoutes];

describe('unguarded routes', () => {
  describe('findUnguardedRoutes', () => {
    it('names a route with no @Access, @Policy or @AllowAnonymous on it or its class', () => {
      expect(findUnguardedRoutes([OpenRoutes])).to.have.members(['OpenRoutes.list', 'OpenRoutes.create']);
    });

    it('accepts @Access, @Policy and @AllowAnonymous on the method', () => {
      expect(findUnguardedRoutes([MethodLevel])).to.deep.eq(['MethodLevel.bare']);
    });

    it('accepts a class-level @Access, @Policy or @AllowAnonymous for every method', () => {
      expect(findUnguardedRoutes(GUARDED)).to.deep.eq([]);
    });

    it('lists the routes of a controller registered twice once', () => {
      expect(findUnguardedRoutes([OpenRoutes, MethodLevel, ClassAccess, OpenRoutes])).to.have.members(['OpenRoutes.list', 'OpenRoutes.create', 'MethodLevel.bare']);
    });
  });

  describe('UnguardedRoutesReport', () => {
    let child: IContainer | undefined;

    afterEach(async () => {
      await child?.dispose();
      child = undefined;
    });

    async function report(mode: string | undefined) {
      const booted = await bootConfiguration({ authz: { http: mode === undefined ? {} : { unguardedRoutes: mode } } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
      child = booted.child;
      const warn = sinon.spy();
      const instance = bindConfiguration(new UnguardedRoutesReport(), child);
      Object.defineProperty(instance, 'Log', { value: { warn } });
      return { instance, warn };
    }

    it('warns once per unguarded route by default', async () => {
      const { instance, warn } = await report(undefined);

      expect(instance.run([OpenRoutes, MethodLevel, ClassAccess])).to.have.members(['OpenRoutes.list', 'OpenRoutes.create', 'MethodLevel.bare']);

      expect(warn.callCount).to.eq(3);
      const logged = warn.getCalls().map((c) => JSON.stringify(c.args));
      for (const route of ['OpenRoutes.list', 'OpenRoutes.create', 'MethodLevel.bare']) {
        expect(logged.filter((l) => l.includes(route)), route).to.have.length(1);
      }
    });

    it('does not warn about the same route on a second run', async () => {
      const { instance, warn } = await report('warn');

      instance.run([OpenRoutes]);
      instance.run([OpenRoutes, MethodLevel]);

      expect(warn.callCount).to.eq(3);
    });

    it('warns about nothing when every route is guarded', async () => {
      const { instance, warn } = await report('warn');

      expect(instance.run(GUARDED)).to.deep.eq([]);
      expect(warn.called).to.eq(false);
    });

    it('throws an AuthzConfigError naming every Controller.method in mode throw', async () => {
      const { instance, warn } = await report('throw');

      let thrown: unknown;
      try {
        instance.run([OpenRoutes, MethodLevel]);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).to.be.instanceOf(AuthzConfigError);
      const message = (thrown as Error).message;
      expect(message).to.include('OpenRoutes.list').and.include('OpenRoutes.create').and.include('MethodLevel.bare');
      expect(message).not.to.include('MethodLevel.byAccess');
      expect(warn.called).to.eq(false);
    });

    it('does not throw in mode throw when every route is guarded', async () => {
      const { instance } = await report('throw');

      expect(() => instance.run(GUARDED)).not.to.throw();
    });

    it('reports nothing in mode off', async () => {
      const { instance, warn } = await report('off');

      expect(instance.run([OpenRoutes])).to.deep.eq([]);
      expect(warn.called).to.eq(false);
    });
  });

  describe('at http server start', function () {
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
      DI.unregister(OpenRoutes);
      DI.uncache(OpenRoutes);
      await DI.get(PrincipalMiddleware)?.dispose();
      DI.uncache(PrincipalMiddleware);
      await testHost.resetRoot();
      if (installedHere) await testHost.uninstallHost();
    });

    it('stops the http server, before booting authz, when mode throw finds an unguarded route', async () => {
      DI.uncache(PrincipalMiddleware);
      await testHost.resetRoot();
      testHost.config().set(['authz', 'http', 'unguardedRoutes'], 'throw');
      DI.register(OpenRoutes).as(BaseController);
      try {
        const middleware = (await DI.resolve(PrincipalMiddleware)) as PrincipalMiddleware;
        const server = { stop: sinon.stub().resolves() };

        DI.RootContainer.emit('http.server.listening', server);
        await new Promise((r) => setImmediate(r));

        expect(server.stop.calledOnce).to.eq(true);
        await middleware.dispose();
      } finally {
        DI.unregister(OpenRoutes);
        testHost.config().unset(['authz', 'http', 'unguardedRoutes']);
      }
    });
  });
});

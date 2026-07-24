import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import os from 'os';
import { join } from 'path';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, Ok, Get } from '@spinajs/http';
import { AuthorizedPolicy, RbacMiddleware, RbacPolicy } from '@spinajs/rbac-http';

import { dir, req, TestConfiguration } from './common.js';
import { UserController } from '../src/controllers/UserController.js';

/**
 * The TestConfiguration shared with `rbac-http.test.ts` cannot actually boot an
 * http server: it declares no fs provider for the controller cache and no
 * cookie secret, so `DefaultControllerCache` and rbac's `RbacMiddleware` both
 * blow up during resolve. Rather than touch the shared file ( and with it the
 * pre-existing suite ), the missing values are added here.
 */
class OverrideTestConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    const cfg = this.Config as any;

    // fsNative CREATES its basePath, so every path here points at a directory
    // that is either real or throwaway - never at a spot inside the repo that
    // would be left behind as junk.
    cfg.fs.providers.push(
      { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(os.tmpdir(), 'spinajs-rbac-http-user-controller-cache') },
      { service: 'fsNative', name: '__fs_http_response_templates__', basePath: dir('./../../http/src/views/responses') },
      { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
    );

    // RbacMiddleware refuses to resolve without it ( eg. it signs the ssid
    // cookie ). No request in this suite carries a session, so the value only
    // has to exist.
    cfg.http.cookie = { secret: 'controller-override-test-secret' };
  }
}

/**
 * An application replacing a controller that ships inside a package.
 * rbac-http-user is NOT modified - the app subclasses UserController and
 * registers the subclass as the base, which is the whole public contract.
 */
class AppUserController extends UserController {
  // Return type widened on purpose: TypeScript requires an override to stay
  // assignable to the base member, and the package's `refresh` is declared as
  // returning the user model. An application replacing a route is free to
  // answer with its own shape, so the declared type is loosened here rather
  // than the assertion below being bent to the package's payload
  // ( eg. `Ok<any>` instead of `Ok<ModelData<User>>` ).
  @Get()
  public async refresh(): Promise<Ok<any>> {
    return new Ok({ overridden: true });
  }
}

describe('controller override end to end', function () {
  this.timeout(25000);

  before(async () => {
    DI.setESMModuleSupport();

    // Three stubs, all of them authentication plumbing that stands between a
    // request and the handler. Each one is a reduction in what this suite
    // proves, so they are kept to exactly what fires on `user/*`:
    //
    // 1. UserController carries @Policy(AuthorizedPolicy), which the subclass
    //    now INHERITS - otherwise every request is 401 before any handler runs.
    // 2. Its routes carry @Permission(), which attaches RbacPolicy - that one
    //    needs a real session and a populated AccessControl.
    // 3. RbacMiddleware runs on EVERY request and builds a `User` ORM model out
    //    of the session ( or a guest ), which needs a configured database. This
    //    package's tests have none, so it answers 500 before routing happens.
    //    The replacement puts a role-less user in storage, which is the least
    //    that lets the package's own `getGrants` run to completion.
    //
    // None of them touches routing, controller resolution or descriptors, which
    // is what the assertions below are about.
    sinon.stub(AuthorizedPolicy.prototype, 'execute').resolves();
    sinon.stub(RbacPolicy.prototype, 'execute').resolves();
    sinon.stub(RbacMiddleware.prototype, 'before').returns((req: any, _res: any, next: any) => {
      req.storage.User = { Role: [] };
      next();
    });

    DI.register(OverrideTestConfiguration).as(Configuration);

    // Bootstrap before resolving anything - the bootstrappers register the
    // framework's services ( eg. AccessControl, the rbac route-arg extractors,
    // ORM wiring ) that Controllers and the http stack then resolve against.
    // Resolve first and those lookups come up empty.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    // order matters - @Config getters fire during fs / controller resolution
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);

    // the app's override, declared before controllers are resolved
    DI.register(AppUserController).as(UserController);

    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    sinon.restore();

    // These suites share one global container, so this file has to leave it as
    // it found it. Two distinct leaks to undo:
    //
    // 1. This file's registrations stay LIVE ( `OverrideTestConfiguration` as
    //    Configuration, `AppUserController` as UserController ). A sibling suite
    //    registering its own `TestConfiguration` adds a second entry, but this
    //    file's is still there - so unregister ours explicitly rather than
    //    rely on it being displaced.
    DI.unregister(OverrideTestConfiguration);
    DI.unregister(AppUserController);

    // 2. This file RESOLVED and CACHED the singletons ( Configuration,
    //    AccessControl, fs, Controllers ). Without clearing, a sibling suite
    //    that resolves Configuration gets MY cached instance straight back out
    //    of the cache, never constructing its own - which is what actually
    //    broke 5 ImpersonationController tests before this line was added.
    DI.clearCache();
  });

  it('routes the overridden action to the application controller', async () => {
    const res = await req().get('user/refresh').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(res.body).to.containSubset({ overridden: true });
  });

  it('mounts the application controller, not the package one', async () => {
    const mounted = (await DI.resolve(Array.ofType(BaseController))).map((c: object) => c.constructor.name);

    expect(mounted).to.include('AppUserController');
    expect(mounted).to.not.include('UserController');
  });

  it('still exposes a route the override did not redeclare', async () => {
    // `getGrants` ( served at user/grants ) is declared only on the package's
    // UserController and must survive the override. Assert on the descriptor -
    // that is where route inheritance actually happens - rather than only on a
    // status code. Routes are keyed by MEMBER name, not by path.
    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const app = all.find((c) => c.constructor.name === 'AppUserController')!;

    expect([...app.Descriptor.Routes.keys()]).to.include('getGrants');

    // ...and it is genuinely mounted, not merely described: the inherited
    // handler runs and returns its own 200, which an unmounted route could not.
    // ( `getGrants` reads AC.getGrants() and maps over the storage user's roles
    // - both satisfied by the empty-role user the middleware stub installs. )
    const res = await req().get('user/grants').set('Accept', 'application/json');
    expect(res.status).to.eq(200);
  });
});

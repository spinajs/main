import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { BaseController, Get, Ok } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import type { User } from '@spinajs/users';

import { UserController } from '../../src/controllers/UserController.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { UsersHttpApp } from '../support/http-app.js';

/**
 * An application replacing a controller that ships inside a package: it subclasses `UserController` and registers the
 * subclass as the base; users-http itself is untouched.
 */
class AppUserController extends UserController {
  // The answer shape is the application's own, so the return type is widened past the package's.
  @Get('/')
  @Access('user:read')
  public async refresh(): Promise<Ok<any>> {
    return new Ok({ overridden: true });
  }
}

describe('users-http v3: controller override end to end', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  let me: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    DI.register(AppUserController).as(UserController);
    // The harness mounts what a controller scan registers, UserController; the line above makes it resolve to the subclass.
    app = await startUsersHttpApp({ controllers: [UserController] });
    me = await app.seedUser({ login: 'me', email: 'me@spinajs.test', roles: ['user'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    DI.unregister(AppUserController);
    sinon.restore();
  });

  it('routes the overridden action to the application controller', async () => {
    const res = await (await app.signIn(me.Uuid)).get('/user');

    expect(res.status, res.text).to.eq(200);
    expect(res.body).to.deep.eq({ overridden: true });
  });

  it('keeps the override behind @Access: an anonymous request is 401', async () => {
    const res = await app.anonymous().get('/user');

    expect(res.status, res.text).to.eq(401);
  });

  it('mounts the application controller, not the package one', async () => {
    const mounted = ((await DI.resolve(Array.ofType(BaseController))) as BaseController[]).map((c) => c.constructor.name);

    expect(mounted).to.include('AppUserController');
    expect(mounted).to.not.include('UserController');
  });

  it('still exposes a route the override did not redeclare, still behind @Access', async () => {
    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const mounted = all.find((c) => c.constructor.name === 'AppUserController')!;

    expect([...mounted.Descriptor.Routes.keys()]).to.include('tokenProfiles');

    // 401, not 404: the inherited route is mounted and its inherited guard runs; an unmounted path is 404.
    expect((await app.anonymous().get('/user/tokens/profiles')).status).to.eq(401);
    expect((await app.anonymous().get('/user/no-such-route')).status).to.eq(404);
  });
});

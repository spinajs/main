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
 * An application replacing a controller that ships inside a package: it subclasses `UserController` and mounts the
 * subclass instead. Registering the subclass `.as(UserController)` is not done here: it leaves empty registry entries
 * behind that break `DI.resolve` of the admin controllers in the suites that run after this one.
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
    app = await startUsersHttpApp({ controllers: [AppUserController] });
    me = await app.seedUser({ login: 'me', email: 'me@spinajs.test', roles: ['user'] });
  });

  after(async () => {
    await stopUsersHttpApp();
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

    // 401, not 404: the inherited route is mounted and its inherited guard runs.
    const res = await app.anonymous().get('/user/tokens/profiles');
    expect(res.status, res.text).to.eq(401);
  });
});

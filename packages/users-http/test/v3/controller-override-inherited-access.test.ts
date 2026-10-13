import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { Get, Ok } from '@spinajs/http';
import { CurrentUser } from '../../src/args/current-user.js';
import type { User } from '@spinajs/users';

import { UserController } from '../../src/controllers/UserController.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { UsersHttpApp } from '../support/http-app.js';

/** Redeclares the route with its own http decorator and no `@Access`: the inherited rule must still guard it. */
class RedeclaredUserController extends UserController {
  @Get('/')
  public async refresh(@CurrentUser() user: User): Promise<Ok<any>> {
    return new Ok({ Login: user.Login, Email: user.Email, Uuid: user.Uuid });
  }
}

/** Replaces only the method body, no decorator at all. */
class BodyOnlyUserController extends UserController {
  public async refresh(user: User): Promise<Ok<any>> {
    return new Ok({ Login: user.Login, Email: user.Email, Uuid: user.Uuid });
  }
}

for (const Override of [RedeclaredUserController, BodyOnlyUserController]) {
  describe(`users-http v3: ${Override.name} keeps the inherited @Access`, function () {
    this.timeout(60000);

    let app: UsersHttpApp;
    let reader: User;
    let noRoles: User;

    before(async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
      DI.register(Override).as(UserController);
      app = await startUsersHttpApp({ controllers: [UserController] });
      reader = await app.seedUser({ login: 'reader', email: 'reader@spinajs.test', roles: ['user'] });
      noRoles = await app.seedUser({ login: 'no-roles', email: 'no-roles@spinajs.test' });
    });

    after(async () => {
      await stopUsersHttpApp();
      DI.unregister(Override);
      sinon.restore();
    });

    it('mounts the override', async () => {
      expect((await DI.resolve(UserController))!.constructor).to.eq(Override);
    });

    it('answers a signed-in caller holding user:read, limited to the fields its role reads', async () => {
      const res = await (await app.signIn(reader.Uuid)).get('/user');

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq({ Login: 'reader', Email: 'reader@spinajs.test' });
    });

    it('refuses a signed-in caller without user:read', async () => {
      const res = await (await app.signIn(noRoles.Uuid)).get('/user');

      expect(res.status, res.text).to.eq(403);
    });

    it('answers 401 to an anonymous request', async () => {
      const res = await app.anonymous().get('/user');

      expect(res.status, res.text).to.eq(401);
    });
  });
}

describe('users-http v3: the package controller after an override is unregistered', function () {
  it('resolves UserController itself again', async () => {
    DI.uncache(UserController);
    expect((await DI.resolve(UserController))!.constructor).to.eq(UserController);
  });
});

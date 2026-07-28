import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import * as cs from 'cookie-signature';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';

import { AuthProvider, BasicPasswordProvider, MemorySessionStore, PasswordProvider, SessionProvider, SimpleDbAuthProvider, User, UserSession } from '@spinajs/rbac';

import { UserController } from '../src/controllers/UserController.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * Database backed tests for the "my account" controller: reading the current
 * user back, reading their grants and changing their own password. The pure
 * unit test in `z-controller-refresh.test.ts` covers the session-cookie
 * handling of refresh() with hand-built fakes; this suite runs the same code
 * against a real user row and a real session provider.
 */

const COOKIE_SECRET = 'rbac-http-user-db-test-secret';
const body = async <T = any>(r: any): Promise<T> => await r.responseData;

describe('UserController (database backed)', function () {
  this.timeout(25000);

  const USER_UUID = 'ffffffff-1111-4111-8111-ffffffffffff';

  let controller: UserController;
  let user: User;
  let sessionStore: MemorySessionStore;

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    // sibling suites in this package leave their own Configuration / providers
    // resolved in the container; start from a clean cache so this suite runs
    // against its own wiring regardless of file order
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    // sibling suites leave their own fake session store registered
    DI.register(MemorySessionStore).as(SessionProvider);

    // `controller-override.test.ts` aliases UserController to its own subclass
    // and never unregisters it, so the real class is claimed back here — DI
    // hands out the last registration.
    DI.register(UserController).as(UserController);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    controller = await DI.resolve(UserController);

    // Sibling suites register their own fake session stores under the
    // SessionProvider base and never remove them, and DI keeps the first
    // registration of a given implementation — so the store the controller
    // gets injected depends on file order. Pin the real one explicitly.
    sessionStore = await DI.resolve(MemorySessionStore);
    Object.defineProperty(controller, 'SessionProvider', { value: sessionStore, configurable: true, writable: true });

    const pwd = DI.resolve(BasicPasswordProvider);
    user = new User({
      Uuid: USER_UUID,
      Email: 'me@spinajs.pl',
      Login: 'me',
      Password: await pwd.hash('current123'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
    user.Metadata['user:niceName'] = 'Me';
    await user.Metadata.sync();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  const reload = () => User.where({ Uuid: USER_UUID }).populate('Metadata').firstOrFail();

  describe('refresh', () => {
    it('returns the current user without the password hash', async () => {
      const data = await body<any>(await controller.refresh(await reload(), ''));

      expect(data.Uuid).to.eq(USER_UUID);
      expect(data.Login).to.eq('me');
      expect(data.Password, 'password hash must never be returned').to.be.undefined;
      expect(data.Id, 'internal id must never be returned').to.be.undefined;
    });

    it('reloads values that changed in the database behind the request', async () => {
      const stale = await reload();

      // somebody else ( eg. an admin ) renames the account meanwhile
      await User.update({ Login: 'renamed' }).where({ Uuid: USER_UUID });

      const data = await body<any>(await controller.refresh(stale, ''));

      expect(data.Login).to.eq('renamed');
    });

    it('writes the user uuid into the session so the next request still resolves the user', async () => {
      const session = new UserSession();
      session.Data.set('User', 'stale');
      await sessionStore.save(session);

      await controller.refresh(await reload(), cs.sign(session.SessionId, COOKIE_SECRET));

      const stored = await sessionStore.restore(session.SessionId);
      expect(stored!.Data.get('User')).to.eq(USER_UUID);
    });
  });

  describe('getGrants', () => {
    it('returns the grants of the roles the user has', async () => {
      const result = await controller.getGrants(await reload());
      const grants = await body<any>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(grants).to.have.property('user.metadata');
      expect(Object.keys(grants['user.metadata'])).to.include.members(['read:own', 'update:own']);
    });

    it('does not leak grants of roles the user does not have', async () => {
      const grants = await body<any>(await controller.getGrants(await reload()));

      // `users` is granted to admin only in the test configuration
      expect(grants).to.not.have.property('users');
    });
  });

  describe('newPassword', () => {
    it('changes the password when the old one matches', async () => {
      const result = await controller.newPassword(await reload(), { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any);
      await body(result);

      const pwd = DI.resolve(BasicPasswordProvider);
      const updated = await reload();

      expect(await pwd.verify(updated.Password, 'brandnew1'), 'new password must be accepted').to.eq(true);
      expect(await pwd.verify(updated.Password, 'current123'), 'old password must stop working').to.eq(false);
    });

    it('rejects when the confirmation does not match', async () => {
      await expect(controller.newPassword(await reload(), { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'different1' } as any)).to.be.rejected;

      const pwd = DI.resolve(BasicPasswordProvider);
      expect(await pwd.verify((await reload()).Password, 'current123'), 'password must be left alone').to.eq(true);
    });

    it('rejects when the old password is wrong', async () => {
      const result = await controller.newPassword(await reload(), { OldPassword: 'not-my-password', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any);

      await expect(body(result)).to.be.rejected;

      const pwd = DI.resolve(BasicPasswordProvider);
      expect(await pwd.verify((await reload()).Password, 'current123'), 'password must be left alone').to.eq(true);
    });
  });
});

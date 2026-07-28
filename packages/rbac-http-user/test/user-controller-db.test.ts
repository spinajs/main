import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

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

      // `@Cookie(true)` unsigns before the handler sees it, so the handler is
      // called with the plain session id — the same value the framework
      // extractor produces from the signed cookie.
      await controller.refresh(await reload(), session.SessionId);

      const stored = await sessionStore.restore(session.SessionId);
      expect(stored!.Data.get('User')).to.eq(USER_UUID);
    });
  });

  describe('getGrants', () => {
    /** Session carrying an ActiveRole, as the rbac middleware would leave it. */
    const sessionWith = (activeRole?: string) => {
      const s = new UserSession();
      if (activeRole) s.Data.set('ActiveRole', activeRole);
      return s;
    };

    it('returns the grants of the roles the user has', async () => {
      const result = await controller.getGrants(await reload(), sessionWith('user'));
      const grants = await body<any>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(grants).to.have.property('user.metadata');
      expect(Object.keys(grants['user.metadata'])).to.include.members(['read:own', 'update:own']);
    });

    it('does not leak grants of roles the user does not have', async () => {
      const grants = await body<any>(await controller.getGrants(await reload(), sessionWith('user')));

      // `users` is granted to admin only in the test configuration
      expect(grants).to.not.have.property('users');
    });

    it('falls back to the first assigned role when the session names no active role', async () => {
      const grants = await body<any>(await controller.getGrants(await reload(), sessionWith()));

      expect(grants).to.have.property('user.metadata');
    });

    it('reports only the active role — not the union of every assigned role', async () => {
      // A multi-role user acting as 'user' must not be told about the grants
      // of 'admin': enforcement resolves ActiveRole, so reporting the union
      // advertises actions the server would refuse.
      const multiRole = await reload();
      multiRole.Role = ['user', 'admin'];

      const asUser = await body<any>(await controller.getGrants(multiRole, sessionWith('user')));
      const asAdmin = await body<any>(await controller.getGrants(multiRole, sessionWith('admin')));

      expect(asUser, 'acting as user must not expose the admin-only resource').to.not.have.property('users');
      expect(asAdmin, 'acting as admin must expose the admin-only resource').to.have.property('users');
    });
  });

  describe('newPassword', () => {
    /** A live session of this user, as the middleware would have restored it. */
    const liveSession = async (loaded: User) => {
      const s = new UserSession();
      s.UserId = loaded.Id;
      s.Data.set('User', USER_UUID);
      s.Data.set('Logged', true);
      s.Data.set('Authorized', true);
      await sessionStore.save(s);
      return s;
    };

    it('changes the password when the old one matches', async () => {
      const loaded = await reload();
      const result = await controller.newPassword(loaded, { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any, await liveSession(loaded));
      await body(result);

      const pwd = DI.resolve(BasicPasswordProvider);
      const updated = await reload();

      expect(await pwd.verify(updated.Password, 'brandnew1'), 'new password must be accepted').to.eq(true);
      expect(await pwd.verify(updated.Password, 'current123'), 'old password must stop working').to.eq(false);
    });

    it('destroys every session opened with the old password', async () => {
      const loaded = await reload();

      // the caller's own session plus one from another device
      const mine = await liveSession(loaded);
      const otherDevice = await liveSession(loaded);

      await body(await controller.newPassword(loaded, { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any, mine));

      expect(await sessionStore.restore(mine.SessionId), 'the session the change was made from must not survive').to.be.null;
      expect(await sessionStore.restore(otherDevice.SessionId), 'a session on another device must not survive').to.be.null;
    });

    it('issues a fresh session for the caller so the password change does not log them out', async () => {
      const loaded = await reload();
      const mine = await liveSession(loaded);

      const result: any = await controller.newPassword(loaded, { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any, mine);
      await body(result);

      const issued = (result.options?.Coockies ?? [])[0];
      expect(issued, 'a replacement session cookie must be returned').to.not.be.undefined;
      expect(issued.Value).to.not.equal(mine.SessionId);

      const restored = await sessionStore.restore(issued.Value);
      expect(restored, 'the replacement session must exist in the store').to.not.be.null;
      expect(restored!.Data.get('User')).to.eq(USER_UUID);
      expect(restored!.Data.get('Authorized')).to.eq(true);
    });

    it('rejects when the confirmation does not match', async () => {
      const loaded = await reload();
      await expect(controller.newPassword(loaded, { OldPassword: 'current123', Password: 'brandnew1', ConfirmPassword: 'different1' } as any, await liveSession(loaded))).to.be.rejected;

      const pwd = DI.resolve(BasicPasswordProvider);
      expect(await pwd.verify((await reload()).Password, 'current123'), 'password must be left alone').to.eq(true);
    });

    it('rejects when the old password is wrong', async () => {
      const loaded = await reload();
      const mine = await liveSession(loaded);

      await expect(controller.newPassword(loaded, { OldPassword: 'not-my-password', Password: 'brandnew1', ConfirmPassword: 'brandnew1' } as any, mine)).to.be.rejected;

      const pwd = DI.resolve(BasicPasswordProvider);
      expect(await pwd.verify((await reload()).Password, 'current123'), 'password must be left alone').to.eq(true);
      expect(await sessionStore.restore(mine.SessionId), 'a failed attempt must not revoke anything').to.not.be.null;
    });
  });
});

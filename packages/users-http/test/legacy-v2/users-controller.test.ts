import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'async_hooks';
import { DateTime } from 'luxon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { IWhereBuilder, MODEL_STATIC_MIXINS, Orm, SortOrder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, IRoute, NotFound, Ok } from '@spinajs/http';
import { PaginationDTO, OrderDTO, IFilterRequest, FilterableLogicalOperators } from '@spinajs/orm-http';
import { RbacPolicy } from '@spinajs/authn-http';

import {
  AuthProvider,
  BasicPasswordProvider,
  OrmPermission,
  OrmPermissionPolicy,
  OrmResource,
  PasswordProvider,
  RBAC_USER_MODEL,
  RbacBootstrapper,
  SessionProvider,
  SimpleDbAuthProvider,
  User,
  UserCreated,
  UserMetadata,
  UserSession,
  USER_COMMON_METADATA,
} from '@spinajs/users';
import { TWO_FA_METATADATA_KEYS } from '@spinajs/authn-totp';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Roles } from '@spinajs/authz-http-admin';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Profile } from '../../src/admin/controllers/Users/Profile.js';

import { TestConfiguration } from './admin-common.js';
/**
 * 2.x tests of the admin user controllers whose 3.0 replacements belong to other lanes (LEDGER
 * `users-controller.test.ts`): credential routes (rows 72, 74, 81–88, target N8b) and the route gate
 * (rows 90, 91, blocked on N8a's `@Access`). Kept as they were; excluded from the package run.
 */

/**
 * Integration tests for the admin user-management controllers.
 *
 * Controllers are resolved through the real DI container and their handlers are
 * called directly against a real in-memory sqlite database. Route decorators
 * (@FromModel, @Body, @Query ...) only shape how arguments are produced by the
 * http layer, so the arguments are supplied by hand here — everything below the
 * handler signature (rbac actions, ORM queries, dehydration, the role guard) is
 * the real thing.
 *
 * NOTE: calling handlers directly bypasses @Body validation, so a test asserting
 * "the DTO rejects X" would prove nothing here. Those live in the HTTP-level
 * suite instead.
 */

/** Ok/Response keeps its payload and options protected — read them for assertions. */
const body = async <T = any>(r: any): Promise<T> => {
  const data = r.responseData;
  return Array.isArray(data) ? ((await Promise.all(data)) as any) : await data;
};
const headers = (r: any) => (r.options?.Headers ?? []) as Array<{ Name: string; Value: any }>;

const filterReq = (Column: string, Operator: string, Value: any): IFilterRequest => ({ filters: [{ Column, Operator, Value }], op: FilterableLogicalOperators.And } as any);

describe('Admin user controllers', function () {
  this.timeout(25000);

  let usersController: Users;
  let rolesController: Roles;
  let securityController: Security;
  let profileController: Profile;

  /** queue emit is stubbed everywhere — assertions read events from here */
  let emitStub: sinon.SinonStub;

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    usersController = await DI.resolve(Users);
    rolesController = await DI.resolve(Roles);
    securityController = await DI.resolve(Security);
    profileController = await DI.resolve(Profile);

    await seed();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  /**
   * Every test starts from the same four accounts. TWO administrators, because
   * the role guard refuses any operation that would leave none — a single-admin
   * fixture would make every deactivate/delete/revoke test fail for the wrong
   * reason. The database lives in memory and is recreated per test
   * (DI.clearCache drops the Orm instance), so seeding cannot leak between tests.
   */
  const ADMIN_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const ADMIN2_UUID = 'dddddddd-4444-4444-8444-dddddddddddd';
  const USER_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const INACTIVE_UUID = 'cccccccc-3333-4333-8333-cccccccccccc';

  async function seed() {
    const pwd = DI.resolve(PasswordProvider);

    const admin = new User({
      Uuid: ADMIN_UUID,
      Email: 'admin@spinajs.pl',
      Login: 'admin',
      Password: await pwd.hash('admin1234'),
      Role: ['admin'],
      IsActive: true,
    });
    await admin.insert();
    admin.Metadata['user:niceName'] = 'The Admin';
    await admin.Metadata.sync();

    const admin2 = new User({
      Uuid: ADMIN2_UUID,
      Email: 'admin2@spinajs.pl',
      Login: 'admin2',
      Password: await pwd.hash('admin1234'),
      Role: ['admin'],
      IsActive: true,
    });
    await admin2.insert();

    const user = new User({
      Uuid: USER_UUID,
      Email: 'user@spinajs.pl',
      Login: 'user',
      Password: await pwd.hash('user1234'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
    user.Metadata['user:niceName'] = 'Regular User';
    user.Metadata['user:phone'] = '123456789';
    await user.Metadata.sync();

    const inactive = new User({
      Uuid: INACTIVE_UUID,
      Email: 'inactive@spinajs.pl',
      Login: 'inactive',
      Password: await pwd.hash('inactive1234'),
      Role: ['user'],
      IsActive: false,
    });
    await inactive.insert();
  }

  const byUuid = (uuid: string) => User.where({ Uuid: uuid }).populate('Metadata').firstOrFail();
  const admin = () => byUuid(ADMIN_UUID);

  describe('Security', () => {
    it('changes the user password to a new, verifiable one', async () => {
      const user = await byUuid(USER_UUID);
      const oldHash = user.Password;

      const result = await securityController.changeUserPassword(user, { password: 'brandnew123', confirmPassword: 'brandnew123' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Password).to.not.eq(oldHash);

      const pwd = DI.resolve(PasswordProvider);
      expect(await pwd.verify(updated.Password, 'brandnew123')).to.eq(true);
    });


    it('issues a password reset token without returning it', async () => {
      const result = await securityController.requestPasswordReset(await byUuid(USER_UUID));
      expect(result).to.be.instanceOf(Ok);
      expect(await body<any>(result), 'the token must never travel back').to.be.undefined;

      const updated = await byUuid(USER_UUID);
      expect(updated.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.be.a('string');
    });


    it('expires a password, which takes the account out of service', async () => {
      const result = await securityController.expireUserPassword(await admin(), await byUuid(USER_UUID));
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(USER_UUID)).IsActive, 'an expired password must stop the account acting').to.eq(false);
    });

    it('refuses to expire the caller s own password', async () => {
      await expect(securityController.expireUserPassword(await admin(), await byUuid(ADMIN_UUID))).to.be.rejectedWith(/your own account/);
    });

    it('resets the 2fa secrets of a user', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN] = 'SOMESECRET';
      user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED] = true;
      await user.Metadata.sync();

      const result = await securityController.reset2faToken(await byUuid(USER_UUID));
      expect(result).to.be.instanceOf(Ok);

      const left = await UserMetadata.where({ user_id: user.Id })
        .whereIn('Key', [TWO_FA_METATADATA_KEYS.TOKEN, TWO_FA_METATADATA_KEYS.ENABLED])
        .selectCount();

      expect(left, '2fa secrets must be gone once the reset returns').to.eq(0);
    });

    it('enables and disables 2fa for a user', async () => {
      const enrolment = await body<string>(await securityController.enable2Fa(await byUuid(USER_UUID)));
      expect(enrolment, 'the enrolment url is what an admin hands to the user').to.match(/^otpauth:\/\//);

      let user = await byUuid(USER_UUID);
      expect(user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]).to.eq(true);

      await securityController.disable2Fa(await byUuid(USER_UUID));

      user = await byUuid(USER_UUID);
      expect(user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]).to.be.null;
    });

    it('drops every session of the user on forced logout', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);
      const spy = sinon.stub(sessionProvider, 'deleteByUser').resolves();
      Object.defineProperty(securityController, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });

      const result = await securityController.logoutUser(user);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnceWithExactly(spy, user.Id);
    });

    it('lists sessions by opaque handle, never by session id', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);

      const session = new UserSession();
      session.UserId = user.Id;
      await sessionProvider.save(session);

      Object.defineProperty(securityController, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });

      const entries = await body<any[]>(await securityController.listSessions(user));

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].Handle).to.be.a('string');
      expect(entries[0].Handle, 'the raw session id is a working credential').to.not.eq(session.SessionId);
      expect(JSON.stringify(entries)).to.not.include(session.SessionId);
    });

    it('revokes a single session by handle', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);

      const session = new UserSession();
      session.UserId = user.Id;
      await sessionProvider.save(session);

      Object.defineProperty(securityController, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });

      const entries = await body<any[]>(await securityController.listSessions(user));
      const result = await securityController.revokeSession(user, entries[0].Handle);

      expect(result).to.be.instanceOf(Ok);
      expect(await sessionProvider.restore(session.SessionId)).to.be.null;
    });

    it('reports a not found for a handle that is not this user s', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);
      Object.defineProperty(securityController, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });

      const result = await securityController.revokeSession(user, 'not-a-handle-of-this-user');

      expect(result).to.be.instanceOf(NotFound);
    });
  });


  describe('own-permission route gate + model token', () => {
    /**
     * This suite calls handlers directly everywhere else (see the file-level
     * note), which is exactly what a route-gate test cannot do — the gate lives
     * in `RbacPolicy`, a level above the handler. Rather than stand up a real
     * HTTP server, the descriptor `RbacPolicy.execute` reads is fetched the same
     * way `route-contract.test.ts` does, and `execute` is invoked directly
     * against a minimal request stand-in (only `storage.User` / `storage.Session`
     * are ever read).
     */
    const controllerDescriptor = (instance: object): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, instance) as IControllerDescriptor;

    const routeOf = (instance: object, method: string): IRoute => {
      const route = [...controllerDescriptor(instance).Routes.values()].find((r) => String(r.Method) === method);
      if (!route) {
        throw new Error(`no route for method ${method}`);
      }
      return route;
    };

    const fakeRequest = (user: User) =>
      ({
        storage: {
          User: user,
          Session: { Data: new Map([['Authorized', true]]) },
        },
      }) as any;

    const scopedAdmin = () => new User({ Login: 'scoped', Email: 'scoped-admin@spinajs.pl', Role: ['scoped-admin'], IsActive: true });

    it('readOwn holder passes the route gate on GET /users', async () => {
      // default User model carries no @OrmResource, so with the stock model the
      // list arrives UNSCOPED — this asserts the gate only
      const policy = new RbacPolicy();
      const route = routeOf(usersController, 'list');

      await expect(policy.execute(fakeRequest(scopedAdmin()), route, usersController as any)).to.not.be.rejected;
    });

    it('list is row-scoped once an @OrmResource-carrying subclass is registered', async () => {
      class ScopedUser extends User {}
      OrmResource('users')(ScopedUser);

      class ScopedUserPolicy extends OrmPermissionPolicy<ScopedUser> {
        public scopeRead(q: IWhereBuilder<ScopedUser>, _u: User): void {
          q.where('Login', 'visible-user'); // deterministic marker predicate
        }
      }
      OrmPermission(ScopedUser)(ScopedUserPolicy);

      /**
       * A real application's `RbacUserModel` subclass lives in its own file and
       * carries `@Connection`/`@Model`, so the Orm's model scan discovers it and
       * `applyModelMixins()` binds `query`/`select`/etc. to IT rather than to the
       * base `User` it copies through the prototype chain. `ScopedUser` is
       * declared here, after the `Orm` in this test has already booted and
       * scanned, so that discovery step never runs for it — without these two
       * lines every static query call on it silently falls back to `User`
       * (`.query` is bound with `.bind(User)`, and `createQuery` resolves the
       * builder's `.Model` by NAME from the `__models__` DI registry), and the
       * assertion below would fail with an unscoped list, not the row-scoped one
       * this test exists to prove.
       */
      for (const mixin in MODEL_STATIC_MIXINS) {
        (ScopedUser as any)[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(ScopedUser);
      }
      DI.register(ScopedUser).as('__models__');

      DI.register(ScopedUser).asValue(RBAC_USER_MODEL, true);

      try {
        const pwd = DI.resolve(PasswordProvider);
        await new User({
          Login: 'visible-user',
          Email: 'visible-user@spinajs.pl',
          Password: await pwd.hash('visible1234'),
          Role: ['user'],
          IsActive: true,
        }).insert();

        const store = DI.resolve(AsyncLocalStorage);
        const data = await store.run({ User: scopedAdmin() } as any, async () => {
          const result = await usersController.list();
          return body<any[]>(result);
        });

        expect(data.map((u: any) => u.Login)).to.deep.equal(['visible-user']);
      } finally {
        DI.RootContainer.Cache.remove(RBAC_USER_MODEL);
        new RbacBootstrapper().bootstrap();

        // Undo the `.as('__models__')` registration above (line ~981) — otherwise
        // this test-local ScopedUser stays in the shared `__models__` DI registry
        // for the rest of the process and every later `createQuery()` name-lookup
        // has to search past it forever. `DI.unregister` strips a type from every
        // registry bucket that holds it by matching type name, which is the same
        // idiom the rest of the repo uses to clean up test-registered DI types.
        DI.unregister(ScopedUser);
        expect(DI.getRegisteredTypes('__models__') ?? []).to.not.include(ScopedUser);
      }
    });
  });
});

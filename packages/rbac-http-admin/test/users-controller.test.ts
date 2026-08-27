import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'async_hooks';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MODEL_STATIC_MIXINS, Orm, SortOrder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, IRoute, NotFound, Ok } from '@spinajs/http';
import { PaginationDTO, OrderDTO, IFilterRequest, FilterableLogicalOperators } from '@spinajs/orm-http';
import { RbacPolicy } from '@spinajs/rbac-http';

import {
  AuthProvider,
  BasicPasswordProvider,
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
} from '@spinajs/rbac';
import { TWO_FA_METATADATA_KEYS } from '@spinajs/rbac-http-user';

import { Users } from '../src/controllers/Users/Users.js';
import { Roles } from '../src/controllers/Users/Roles.js';
import { Security } from '../src/controllers/Users/Security.js';
import { Profile } from '../src/controllers/Users/Profile.js';

import { TestConfiguration } from './common.js';

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

  describe('Users.list', () => {
    it('returns all users with the total count header', async () => {
      const result = await usersController.list();

      expect(result).to.be.instanceOf(Ok);

      const data = await body<any[]>(result);
      expect(data).to.have.lengthOf(4);

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total).to.be.not.undefined;
      expect(total!.Value).to.eq(4);
    });

    it('never exposes password hashes nor internal ids', async () => {
      const data = await body<any[]>(await usersController.list());

      for (const u of data) {
        expect(u.Password, 'password hash leaked').to.be.undefined;
        expect(u.Id, 'internal id leaked').to.be.undefined;
        expect(u.Uuid).to.be.a('string');
      }
    });

    it('paginates', async () => {
      const page0 = await body<any[]>(await usersController.list(new PaginationDTO({ page: 0, limit: 2 } as any)));
      const page1 = await body<any[]>(await usersController.list(new PaginationDTO({ page: 1, limit: 2 } as any)));

      expect(page0).to.have.lengthOf(2);
      expect(page1).to.have.lengthOf(2);

      const seen = [...page0, ...page1].map((u: any) => u.Uuid);
      expect(new Set(seen).size, 'pages must not overlap').to.eq(4);
    });

    // Regression: take defaulted the page size to 10 while skip defaulted it to
    // 0, so `page` without `limit` always returned the first page.
    it('honours the page number when no limit is sent', async () => {
      const page0 = await body<any[]>(await usersController.list(new PaginationDTO({ page: 0 } as any)));
      const page1 = await body<any[]>(await usersController.list(new PaginationDTO({ page: 1 } as any)));

      expect(page0).to.have.lengthOf(4);
      expect(page1, 'second page of a 4 row table with the default size of 10 is empty').to.have.lengthOf(0);
    });

    it('orders by the requested column', async () => {
      const asc = await body<any[]>(await usersController.list(new PaginationDTO({ page: 0, limit: 10 } as any), new OrderDTO({ column: 'Login', order: SortOrder.ASC } as any)));

      expect(asc.map((u: any) => u.Login)).to.deep.eq(['admin', 'admin2', 'inactive', 'user']);
    });

    it('rejects a sort column that is not whitelisted', async () => {
      await expect(usersController.list(undefined, new OrderDTO({ column: 'Password', order: SortOrder.ASC } as any))).to.be.rejectedWith(/Cannot sort by/);
    });

    it('includes the Metadata relation when asked to', async () => {
      const withMeta = await body<any[]>(await usersController.list(undefined, undefined, ['Metadata']));
      const user = withMeta.find((u: any) => u.Login === 'user');

      expect(user.Metadata).to.be.an('array');
      expect(user.Metadata.map((m: any) => m.Key)).to.include.members(['user:niceName', 'user:phone']);
    });

    it('filters by login', async () => {
      const data = await body<any[]>(await usersController.list(undefined, undefined, undefined, filterReq('Login', 'eq', 'user')));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('user');
    });

    it('filters by IsActive', async () => {
      const data = await body<any[]>(await usersController.list(undefined, undefined, undefined, filterReq('IsActive', 'eq', false)));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('inactive');
    });

    it('filters by the user:niceName metadata column', async () => {
      const data = await body<any[]>(await usersController.list(undefined, undefined, undefined, filterReq('user:niceName', 'eq', 'The Admin')));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('admin');
    });

    it('caps the page size, so the endpoint cannot be turned into a table dump', async () => {
      const pwd = DI.resolve(PasswordProvider);
      const hash = await pwd.hash('bulk1234');

      for (let i = 0; i < 101; i++) {
        await new User({
          Email: `bulk${i}@spinajs.pl`,
          Login: `bulk${i}`,
          Password: hash,
          Role: ['user'],
          IsActive: true,
        }).insert();
      }

      const data = await body<any[]>(await usersController.list(new PaginationDTO({ page: 0, limit: 1000 } as any)));

      expect(data).to.have.lengthOf(100);
    });

    it('does not leak credential metadata through the listing either', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN] = 'a-token-worth-stealing';
      await user.Metadata.sync();

      const data = await body<any[]>(await usersController.list(undefined, undefined, ['Metadata']));

      expect(JSON.stringify(data)).to.not.include('a-token-worth-stealing');
    });

    it('reports the filtered count, not the table count, in X-Total-Count', async () => {
      const result = await usersController.list(undefined, undefined, undefined, filterReq('IsActive', 'eq', true));

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total!.Value).to.eq(3);
    });
  });

  describe('Users.getSingleUser / getByLogin', () => {
    it('returns the user without password or internal id', async () => {
      const user = await byUuid(USER_UUID);
      const data = await body<any>(await usersController.getSingleUser(user));

      expect(data.Uuid).to.eq(USER_UUID);
      expect(data.Login).to.eq('user');
      expect(data.Password).to.be.undefined;
      expect(data.Id).to.be.undefined;
    });

    it('returns metadata of the user when the relation is populated', async () => {
      const user = await byUuid(USER_UUID);
      const data = await body<any>(await usersController.getByLogin(user, ['Metadata']));

      expect(data.Metadata.map((m: any) => m.Key)).to.include('user:niceName');
    });

    /**
     * Regression, and the reason this route needed a permission decorator at all:
     * `user:pwd_reset:token` is redeemable at the PUBLIC reset endpoint, so a
     * user record that carries it back to a client is an account takeover.
     */
    it('never returns credential-bearing metadata', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN] = 'a-token-worth-stealing';
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL] = '2030-01-01T00:00:00.000Z';
      user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] = true;
      await user.Metadata.sync();

      const data = await body<any>(await usersController.getSingleUser(await byUuid(USER_UUID), ['Metadata']));
      const keys = data.Metadata.map((m: any) => m.Key);

      expect(keys, 'reset token must never be dehydrated').to.not.include(USER_COMMON_METADATA.USER_PWD_RESET_TOKEN);
      expect(keys).to.not.include(USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL);
      expect(keys).to.not.include(USER_COMMON_METADATA.USER_BAN_IS_BANNED);
      expect(keys, 'ordinary metadata still travels').to.include('user:niceName');
      expect(JSON.stringify(data)).to.not.include('a-token-worth-stealing');
    });
  });

  describe('Users.addUser', () => {
    it('creates an inactive user with the requested role', async () => {
      const result = await usersController.addUser(await admin(), { Login: 'newbie', Email: 'newbie@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);

      const created = await User.query().whereLogin('newbie').firstOrFail();
      expect(created.Email).to.eq('newbie@spinajs.pl');
      expect(created.Role).to.include('user');
      expect(created.IsActive, 'new accounts must not be active before confirmation').to.eq(false);
      expect(created.Uuid).to.be.a('string');
    });

    /**
     * `User.Role` has always been a SET, and roles are typically switchable
     * profiles one person may legitimately hold several of (a seller working
     * for two companies, an administrator who also edits content). The DTO
     * accepted a single string, so the only way to give an account a second
     * role was the separate grant route — one request per role, none of them
     * atomic with the creation.
     */
    it('creates a user holding every role of a list', async () => {
      await usersController.addUser(await admin(), { Login: 'multi', Email: 'multi@spinajs.pl', Role: ['user', 'guest'] } as any);

      const created = await User.query().whereLogin('multi').firstOrFail();
      expect(created.Role).to.have.members(['user', 'guest']);
    });

    it('still accepts a single role name', async () => {
      await usersController.addUser(await admin(), { Login: 'single', Email: 'single@spinajs.pl', Role: 'user' } as any);

      expect((await User.query().whereLogin('single').firstOrFail()).Role).to.deep.equal(['user']);
    });

    // Every entry is guard-checked, so a duplicate would be checked twice and
    // stored twice.
    it('trims and de-duplicates the list', async () => {
      await usersController.addUser(await admin(), { Login: 'dedup', Email: 'dedup@spinajs.pl', Role: ['user', ' user ', 'guest'] } as any);

      expect((await User.query().whereLogin('dedup').firstOrFail()).Role).to.have.members(['user', 'guest']);
    });

    // The guard runs per entry, so ONE refused role must refuse the whole
    // request - a partially applied role list is not something the caller asked
    // for and not something they can see.
    it('refuses the whole list when one role is not allowed', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'partly', Email: 'partly@spinajs.pl', Role: ['user', 'superadmin'] } as any)).to.be.rejectedWith(/grants more than the caller holds/);

      expect(await User.query().whereLogin('partly').first(), 'nothing may be created when the guard refuses').to.not.exist;
    });

    /**
     * The temporary password is generated, hashed and thrown away - never
     * returned, never mailed - so without a reset token the new account has no
     * way in at all and an administrator had to remember a second screen.
     */
    it('hands the account over by issuing a password reset token', async () => {
      await usersController.addUser(await admin(), { Login: 'handover', Email: 'handover@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('handover').populate('Metadata').firstOrFail();
      expect(created.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN], 'a new account must be reachable by its owner').to.be.a('string');
    });

    // Regression, reported from production:
    //   "Error in controller POST at path /api/users Exception:
    //    rbac.actions.create.beforeCreate should not be null, undefined or empty"
    // The create action read its middleware lists through a non-nil-checked
    // config helper, so the shipped default (an empty list) — and any app that
    // never declares `rbac.actions` — made every single user creation fail.
    it('creates a user even though no create middleware is configured', async () => {
      const config = DI.get(Configuration)!;
      config.set('rbac.actions', undefined);

      const result = await usersController.addUser(await admin(), { Login: 'nomiddleware', Email: 'nomiddleware@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);
      const created = await User.query().whereLogin('nomiddleware').firstOrFail();
      expect(created.Email).to.eq('nomiddleware@spinajs.pl');
    });

    it('creates a user with an explicitly empty create middleware list', async () => {
      const config = DI.get(Configuration)!;
      config.set('rbac.actions.create.beforeCreate', []);
      config.set('rbac.actions.create.afterCreate', []);

      const result = await usersController.addUser(await admin(), { Login: 'emptymw', Email: 'emptymw@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);
      expect(await User.query().whereLogin('emptymw').firstOrFail()).to.be.not.null;
    });

    it('runs configured beforeCreate middleware', async () => {
      const config = DI.get(Configuration)!;
      config.set('rbac.actions.create.beforeCreate', [
        (u: User) => {
          u.IsActive = true;
          return u;
        },
      ]);

      await usersController.addUser(await admin(), { Login: 'premade', Email: 'premade@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('premade').firstOrFail();
      expect(created.IsActive).to.eq(true);

      config.set('rbac.actions.create.beforeCreate', []);
    });

    it('never returns the generated temporary password nor the hash', async () => {
      const result = await usersController.addUser(await admin(), { Login: 'secret', Email: 'secret@spinajs.pl', Role: 'user' } as any);
      const data = await body<any>(result);

      expect(data.Password, 'password must never travel back to the client').to.be.undefined;
      expect(JSON.stringify(data)).to.not.include('Password');
    });

    it('stores the password hashed, never in plain text', async () => {
      await usersController.addUser(await admin(), { Login: 'hashed', Email: 'hashed@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('hashed').firstOrFail();
      expect(created.Password).to.be.a('string');
      expect(created.Password.length).to.be.greaterThan(20);
    });

    it('attaches metadata passed in the request', async () => {
      await usersController.addUser(await admin(), {
        Login: 'metauser',
        Email: 'metauser@spinajs.pl',
        Role: 'user',
        Metadata: { 'user:niceName': 'Meta User', 'user:phone': '555000555' },
      } as any);

      const created = await User.query().whereLogin('metauser').populate('Metadata').firstOrFail();
      expect(created.Metadata['user:niceName']).to.eq('Meta User');
      expect(created.Metadata['user:phone']).to.eq('555000555');
    });

    it('refuses metadata keys that decide account access', async () => {
      await expect(
        usersController.addUser(await admin(), {
          Login: 'planted',
          Email: 'planted@spinajs.pl',
          Role: 'user',
          Metadata: { [USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]: 'known-token' },
        } as any),
      ).to.be.rejectedWith(/Protected metadata keys cannot be set directly/);

      expect(await User.query().whereLogin('planted').first()).to.not.exist;
    });

    // The metadata relation matches keys as GLOBS, so `*` is not a key — it is
    // "every key", including the protected ones filtered above.
    it('refuses glob metadata keys', async () => {
      await expect(
        usersController.addUser(await admin(), {
          Login: 'globber',
          Email: 'globber@spinajs.pl',
          Role: 'user',
          Metadata: { '*': 'overwritten' },
        } as any),
      ).to.be.rejectedWith(/Protected metadata keys cannot be set directly/);
    });

    it('emits the UserCreated event', async () => {
      await usersController.addUser(await admin(), { Login: 'evented', Email: 'evented@spinajs.pl', Role: 'user' } as any);

      const events = emitStub.getCalls().map((c) => c.args[0]);
      expect(events.some((e) => e instanceof UserCreated)).to.be.true;
    });

    it('rejects a duplicated email with a conflict, not a driver error', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'other', Email: 'user@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(/already in use/);
    });

    it('rejects a duplicated login with a conflict, not a driver error', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'user', Email: 'other@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(/already in use/);
    });

    /**
     * The message alone says something clashed, never WHICH field — a form
     * receiving only that can do nothing but show a banner. `parameter` carries
     * the same ajv-shaped per-field detail a schema rejection does, and
     * `__handle_error__` spreads the exception's own enumerable properties into
     * the body, so it survives the trip to the client.
     */
    it('names the clashing field in the conflict, in the ajv shape a schema rejection uses', async () => {
      const error = await usersController.addUser(await admin(), { Login: 'other', Email: 'user@spinajs.pl', Role: 'user' } as any).catch((e: any) => e);

      expect(error.parameter).to.be.an('array').with.lengthOf(1);
      expect(error.parameter[0]).to.include({ instancePath: '/Email', keyword: 'duplicate' });
      expect(error.parameter[0].params).to.deep.equal({ field: 'Email' });
    });

    it('names both fields when the login and the email are each taken', async () => {
      const error = await usersController.addUser(await admin(), { Login: 'user', Email: 'user@spinajs.pl', Role: 'user' } as any).catch((e: any) => e);

      expect(error.parameter.map((p: any) => p.instancePath)).to.have.members(['/Login', '/Email']);
    });

    it('rejects a malformed email', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'bademail', Email: 'not-an-email', Role: 'user' } as any)).to.be.rejected;
    });

    it('rejects an unknown role', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'nosuchrole', Email: 'nosuchrole@spinajs.pl', Role: 'wizard' } as any)).to.be.rejectedWith(/not declared in rbac configuration/);
    });

    it('rejects a role that grants more than the caller holds', async () => {
      await expect(usersController.addUser(await admin(), { Login: 'wannabe', Email: 'wannabe@spinajs.pl', Role: 'superadmin' } as any)).to.be.rejectedWith(/grants more than the caller holds/);

      expect(await User.query().whereLogin('wannabe').first(), 'nothing may be created when the guard refuses').to.not.exist;
    });

    // A soft-deleted row keeps its place in the unique indexes, so reusing its
    // login is a conflict rather than a fresh registration — and used to be a
    // driver error instead of one.
    it('reports a conflict for a login held by a soft-deleted account', async () => {
      await usersController.removeUser(await admin(), await byUuid(USER_UUID));

      await expect(usersController.addUser(await admin(), { Login: 'user', Email: 'reused@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(/already in use/);
    });
  });

  describe('Users.updateUser', () => {
    it('updates login, email and role', async () => {
      const user = await byUuid(USER_UUID);

      const result = await usersController.updateUser(await admin(), user, { Login: 'renamed', Email: 'renamed@spinajs.pl', Role: 'admin' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('renamed');
      expect(updated.Email).to.eq('renamed@spinajs.pl');
      expect(updated.Role).to.deep.eq(['admin']);
    });

    it('replaces the whole role list when one is sent', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(await admin(), user, { Role: ['user', 'guest'] } as any);

      expect((await byUuid(USER_UUID)).Role).to.have.members(['user', 'guest']);
    });

    // The list is a REPLACEMENT, so dropping an entry is a revocation and goes
    // through the revoke half of the guard.
    it('revokes the roles a shorter list leaves out', async () => {
      const user = await byUuid(USER_UUID);
      await usersController.updateUser(await admin(), user, { Role: ['user', 'guest'] } as any);

      await usersController.updateUser(await admin(), await byUuid(USER_UUID), { Role: ['guest'] } as any);

      expect((await byUuid(USER_UUID)).Role).to.deep.equal(['guest']);
    });

    it('keeps existing values for fields that are not sent', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(await admin(), user, { Login: 'onlylogin' } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('onlylogin');
      expect(updated.Email, 'email must survive a partial update').to.eq('user@spinajs.pl');
      expect(updated.Role, 'role must survive a partial update').to.deep.eq(['user']);
    });

    it('rejects a login already taken by another account', async () => {
      const user = await byUuid(USER_UUID);

      await expect(usersController.updateUser(await admin(), user, { Login: 'admin' } as any)).to.be.rejectedWith(/already in use/);
    });

    it('accepts a no-op update to the account s own login', async () => {
      const user = await byUuid(USER_UUID);

      const result = await usersController.updateUser(await admin(), user, { Login: 'user', Email: 'user@spinajs.pl' } as any);
      expect(result).to.be.instanceOf(Ok);
    });

    it('does not touch other users', async () => {
      const user = await byUuid(USER_UUID);
      await usersController.updateUser(await admin(), user, { Login: 'renamed' } as any);

      const adminUser = await byUuid(ADMIN_UUID);
      expect(adminUser.Login).to.eq('admin');
    });

    it('applies the role guard to a role replacement', async () => {
      const user = await byUuid(USER_UUID);

      await expect(usersController.updateUser(await admin(), user, { Role: 'system' } as any)).to.be.rejectedWith(/system role cannot be/);
    });
  });

  describe('Users.removeUser / restoreUser', () => {
    it('soft deletes the account and drops its sessions', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);
      const spy = sinon.stub(sessionProvider, 'deleteByUser').resolves();

      const result = await usersController.removeUser(await admin(), user);
      expect(result).to.be.instanceOf(Ok);

      const deleted = await User.query().withDeleted().where('Uuid', USER_UUID).first();
      expect(deleted!.DeletedAt, 'row must be kept and stamped').to.be.not.null;
      expect(await User.query().where('Uuid', USER_UUID).first(), 'deleted rows must be invisible to ordinary queries').to.not.exist;

      sinon.assert.calledWith(spy, user.Id);
    });

    it('restores a deleted account without activating it', async () => {
      const user = await byUuid(INACTIVE_UUID);
      await usersController.removeUser(await admin(), user);

      const result = await usersController.restoreUser(INACTIVE_UUID);
      expect(result).to.be.instanceOf(Ok);

      const restored = await byUuid(INACTIVE_UUID);
      expect(restored.DeletedAt).to.be.null;
      expect(restored.IsActive, 'restoring is not activating').to.eq(false);
    });

    it('refuses to restore an account that is not deleted', async () => {
      await expect(usersController.restoreUser(USER_UUID)).to.be.rejectedWith(/is not deleted/);
    });

    it('reports a not found for a uuid that does not exist', async () => {
      await expect(usersController.restoreUser('11111111-2222-4222-8222-333333333333')).to.be.rejectedWith(/not found/);
    });

    it('refuses to delete the caller s own account', async () => {
      const actor = await admin();

      await expect(usersController.removeUser(actor, await byUuid(ADMIN_UUID))).to.be.rejectedWith(/your own account/);
    });
  });

  describe('Roles', () => {
    it('grants a role, keeping the existing ones', async () => {
      const result = await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'admin' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role).to.include.members(['user', 'admin']);
    });

    it('does not duplicate an already granted role', async () => {
      await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'user' } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role.filter((r) => r === 'user')).to.have.lengthOf(1);
    });

    it('revokes a role', async () => {
      await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'admin' } as any);
      const result = await rolesController.revokeRole(await admin(), await byUuid(USER_UUID), { role: 'admin' } as any);

      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role).to.not.include('admin');
      expect(updated.Role).to.include('user');
    });

    it('rejects an empty role name', async () => {
      await expect(rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: '' } as any)).to.be.rejected;
    });
  });

  describe('Role guard', () => {
    it('refuses a role that is not declared in configuration', async () => {
      await expect(rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'wizard' } as any)).to.be.rejectedWith(/not declared in rbac configuration/);
    });

    it('refuses to hand out the system role', async () => {
      await expect(rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'system' } as any)).to.be.rejectedWith(/system role cannot be/);
    });

    /**
     * The escalation this guard exists for: `updateAny` on users is otherwise a
     * path to every other permission in the installation.
     */
    it('refuses to grant a role that holds more than the caller', async () => {
      await expect(rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'superadmin' } as any)).to.be.rejectedWith(/grants more than the caller holds/);
    });

    it('allows a stronger caller to grant that same role', async () => {
      const actor = await admin();
      actor.Role = ['superadmin'];
      await actor.update();

      const result = await rolesController.addRole(await byUuid(ADMIN_UUID), await byUuid(USER_UUID), { role: 'superadmin' } as any);
      expect(result).to.be.instanceOf(Ok);
    });

    it('refuses to revoke the caller s own privileged role', async () => {
      const actor = await admin();

      await expect(rolesController.revokeRole(actor, await byUuid(ADMIN_UUID), { role: 'admin' } as any)).to.be.rejectedWith(/your own 'admin' role/);
    });

    it('refuses to revoke the last privileged role in the installation', async () => {
      // leave exactly one administrator besides the caller, then take that one away
      const second = await byUuid(ADMIN2_UUID);
      second.Role = ['user'];
      await second.update();

      // the caller is now the only admin — deactivating them empties the role
      await expect(securityController.deactivateUser(await byUuid(ADMIN2_UUID), await byUuid(ADMIN_UUID))).to.be.rejectedWith(/no active account holding 'admin'/);
    });

    it('allows removing an administrator while another one remains', async () => {
      const result = await securityController.deactivateUser(await admin(), await byUuid(ADMIN2_UUID));
      expect(result).to.be.instanceOf(Ok);
    });

    it('is switchable: escalation may be allowed', async () => {
      DI.get(Configuration)!.set('rbac.admin.roleGuard.preventEscalation', false);

      const result = await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'superadmin' } as any);
      expect(result).to.be.instanceOf(Ok);
    });

    it('is switchable: unknown roles may be allowed', async () => {
      // Two independent layers each refuse an undeclared role: this controller's
      // own DefaultRoleGuard, and rbac's own assertRolesExist() inside grant()
      // (packages/rbac/src/actions.ts, gated by rbac.requireKnownRole). Both must
      // be turned off for 'wizard' to actually get through - flipping only the
      // guard above would still be refused one layer further in.
      DI.get(Configuration)!.set('rbac.admin.roleGuard.requireKnownRole', false);
      DI.get(Configuration)!.set('rbac.requireKnownRole', false);

      const result = await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'wizard' } as any);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(USER_UUID)).Role).to.include('wizard');
    });

    it('is switchable: the system role may be handed out', async () => {
      DI.get(Configuration)!.set('rbac.admin.roleGuard.protectSystemRole', false);

      // `system` $extends `admin` and adds nothing, so with the system-role
      // block off the escalation check has no reason to refuse it either
      const result = await rolesController.addRole(await admin(), await byUuid(USER_UUID), { role: 'system' } as any);
      expect(result).to.be.instanceOf(Ok);
    });

    it('is switchable: self lockout may be allowed', async () => {
      DI.get(Configuration)!.set('rbac.admin.roleGuard.preventSelfLockout', false);

      const result = await securityController.deactivateUser(await admin(), await byUuid(ADMIN_UUID));
      expect(result).to.be.instanceOf(Ok);
    });

    it('reports only the roles the caller may assign', async () => {
      const roles = await body<string[]>(await usersController.assignableRoles(await admin()));

      expect(roles).to.include.members(['admin', 'user', 'guest']);
      expect(roles, 'system role is never assignable through the API').to.not.include('system');
      expect(roles, 'a stronger role must not be offered').to.not.include('superadmin');
    });
  });

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

    /**
     * Regression: @FromModel does not populate relations unless the route asks
     * for them, and changePassword writes login-throttle metadata. Against an
     * unpopulated relation those writes became INSERTs of keys that already
     * exist, which the (user_id, Key) unique index rejects.
     */
    it('changes the password of a user whose metadata already exists', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = 3;
      user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_LAST_ATTEMPT] = '2020-01-01T00:00:00.000Z';
      await user.Metadata.sync();

      const result = await securityController.changeUserPassword(await byUuid(USER_UUID), { password: 'brandnew123', confirmPassword: 'brandnew123' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(Number(updated.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS]), 'a password change clears the throttle').to.eq(0);
    });

    it('issues a password reset token without returning it', async () => {
      const result = await securityController.requestPasswordReset(await byUuid(USER_UUID));
      expect(result).to.be.instanceOf(Ok);
      expect(await body<any>(result), 'the token must never travel back').to.be.undefined;

      const updated = await byUuid(USER_UUID);
      expect(updated.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.be.a('string');
    });

    it('deactivates an active account', async () => {
      const user = await byUuid(USER_UUID);

      const result = await securityController.deactivateUser(await admin(), user);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(USER_UUID)).IsActive).to.eq(false);
    });

    it('refuses to deactivate the caller s own account', async () => {
      const actor = await admin();

      await expect(securityController.deactivateUser(actor, await byUuid(ADMIN_UUID))).to.be.rejectedWith(/your own account/);
    });

    it('activates an inactive account', async () => {
      const user = await byUuid(INACTIVE_UUID);

      const result = await securityController.activateUser(user);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(INACTIVE_UUID)).IsActive).to.eq(true);
    });

    it('bans and unbans an account', async () => {
      const banned = await securityController.banUser(await admin(), await byUuid(USER_UUID), { reason: 'spam', duration: 3600 } as any);
      expect(banned).to.be.instanceOf(Ok);

      let user = await byUuid(USER_UUID);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.eq(true);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_REASON]).to.eq('spam');
      expect(user.IsBanned).to.eq(true);

      const unbanned = await securityController.unbanUser(await byUuid(USER_UUID));
      expect(unbanned).to.be.instanceOf(Ok);

      user = await byUuid(USER_UUID);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.be.null;
      expect(user.IsBanned).to.eq(false);
    });

    it('refuses to ban the caller s own account', async () => {
      const actor = await admin();

      await expect(securityController.banUser(actor, await byUuid(ADMIN_UUID), {} as any)).to.be.rejectedWith(/your own account/);
    });

    it('clears a login lockout', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = 5;
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL] = '2999-01-01T00:00:00.000Z';
      await user.Metadata.sync();

      const result = await securityController.unlockUser(await byUuid(USER_UUID));
      expect(result).to.be.instanceOf(Ok);

      const left = await UserMetadata.where({ user_id: user.Id })
        .whereIn('Key', [USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS, USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL])
        .selectCount();

      expect(left, 'the throttle must be gone, not merely expired').to.eq(0);
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

  describe('Profile', () => {
    it('returns the profile of a user identified by login', async () => {
      const result = await profileController.getUserProfile('user');
      const data = await body<any>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(data).to.be.not.undefined;

      // Regression: the handler used to hand the pending promise to Ok, which
      // serialized as {} for every client.
      expect(data, 'the profile must be resolved, not a promise').to.not.be.an.instanceOf(Promise);
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
      class ScopedUser extends User {
        public static rbacRead(this: any, _user: User) {
          this.where('Login', 'visible-user'); // deterministic marker predicate
        }
      }
      OrmResource('users')(ScopedUser);

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

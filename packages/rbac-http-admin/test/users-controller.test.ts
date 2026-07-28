import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SortOrder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { PaginationDTO, OrderDTO, IFilterRequest, FilterableLogicalOperators } from '@spinajs/orm-http';

import { AuthProvider, BasicPasswordProvider, PasswordProvider, SessionProvider, SimpleDbAuthProvider, User, UserCreated, UserMetadata } from '@spinajs/rbac';
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
 * handler signature (rbac actions, ORM queries, dehydration) is the real thing.
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
   * Every test starts from the same three accounts. The database lives in
   * memory and is recreated per test (DI.clearCache drops the Orm instance),
   * so seeding cannot leak between tests.
   */
  const ADMIN_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
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

  describe('Users.list', () => {
    it('returns all users with the total count header', async () => {
      const result = await usersController.list();

      expect(result).to.be.instanceOf(Ok);

      const data = await body<any[]>(result);
      expect(data).to.have.lengthOf(3);

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total).to.be.not.undefined;
      expect(total!.Value).to.eq(3);
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
      expect(page1).to.have.lengthOf(1);

      const seen = [...page0, ...page1].map((u: any) => u.Uuid);
      expect(new Set(seen).size, 'pages must not overlap').to.eq(3);
    });

    it('orders by the requested column', async () => {
      const asc = await body<any[]>(await usersController.list(new PaginationDTO({ page: 0, limit: 10 } as any), new OrderDTO({ column: 'Login', order: SortOrder.ASC } as any)));

      expect(asc.map((u: any) => u.Login)).to.deep.eq(['admin', 'inactive', 'user']);
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

    it('reports the filtered count, not the table count, in X-Total-Count', async () => {
      const result = await usersController.list(undefined, undefined, undefined, filterReq('IsActive', 'eq', true));

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total!.Value).to.eq(2);
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
  });

  describe('Users.addUser', () => {
    it('creates an inactive user with the requested role', async () => {
      const result = await usersController.addUser({ Login: 'newbie', Email: 'newbie@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);

      const created = await User.query().whereLogin('newbie').firstOrFail();
      expect(created.Email).to.eq('newbie@spinajs.pl');
      expect(created.Role).to.include('user');
      expect(created.IsActive, 'new accounts must not be active before confirmation').to.eq(false);
      expect(created.Uuid).to.be.a('string');
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

      const result = await usersController.addUser({ Login: 'nomiddleware', Email: 'nomiddleware@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);
      const created = await User.query().whereLogin('nomiddleware').firstOrFail();
      expect(created.Email).to.eq('nomiddleware@spinajs.pl');
    });

    it('creates a user with an explicitly empty create middleware list', async () => {
      const config = DI.get(Configuration)!;
      config.set('rbac.actions.create.beforeCreate', []);
      config.set('rbac.actions.create.afterCreate', []);

      const result = await usersController.addUser({ Login: 'emptymw', Email: 'emptymw@spinajs.pl', Role: 'user' } as any);

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

      await usersController.addUser({ Login: 'premade', Email: 'premade@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('premade').firstOrFail();
      expect(created.IsActive).to.eq(true);

      config.set('rbac.actions.create.beforeCreate', []);
    });

    it('never returns the generated temporary password nor the hash', async () => {
      const result = await usersController.addUser({ Login: 'secret', Email: 'secret@spinajs.pl', Role: 'user' } as any);
      const data = await body<any>(result);

      expect(data.Password, 'password must never travel back to the client').to.be.undefined;
      expect(JSON.stringify(data)).to.not.include('Password');
    });

    it('stores the password hashed, never in plain text', async () => {
      await usersController.addUser({ Login: 'hashed', Email: 'hashed@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('hashed').firstOrFail();
      expect(created.Password).to.be.a('string');
      expect(created.Password.length).to.be.greaterThan(20);
    });

    it('attaches metadata passed in the request', async () => {
      await usersController.addUser({
        Login: 'metauser',
        Email: 'metauser@spinajs.pl',
        Role: 'user',
        Metadata: { 'user:niceName': 'Meta User', 'user:phone': '555000555' },
      } as any);

      const created = await User.query().whereLogin('metauser').populate('Metadata').firstOrFail();
      expect(created.Metadata['user:niceName']).to.eq('Meta User');
      expect(created.Metadata['user:phone']).to.eq('555000555');
    });

    it('emits the UserCreated event', async () => {
      await usersController.addUser({ Login: 'evented', Email: 'evented@spinajs.pl', Role: 'user' } as any);

      const events = emitStub.getCalls().map((c) => c.args[0]);
      expect(events.some((e) => e instanceof UserCreated)).to.be.true;
    });

    it('rejects a duplicated email', async () => {
      await expect(usersController.addUser({ Login: 'other', Email: 'user@spinajs.pl', Role: 'user' } as any)).to.be.rejected;
    });

    it('rejects a duplicated login', async () => {
      await expect(usersController.addUser({ Login: 'user', Email: 'other@spinajs.pl', Role: 'user' } as any)).to.be.rejected;
    });

    it('rejects a malformed email', async () => {
      await expect(usersController.addUser({ Login: 'bademail', Email: 'not-an-email', Role: 'user' } as any)).to.be.rejected;
    });
  });

  describe('Users.updateUser', () => {
    it('updates login, email and role', async () => {
      const user = await byUuid(USER_UUID);

      const result = await usersController.updateUser(user, { Login: 'renamed', Email: 'renamed@spinajs.pl', Role: 'admin' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('renamed');
      expect(updated.Email).to.eq('renamed@spinajs.pl');
      expect(updated.Role).to.deep.eq(['admin']);
    });

    it('keeps existing values for fields that are not sent', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(user, { Login: 'onlylogin' } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('onlylogin');
      expect(updated.Email, 'email must survive a partial update').to.eq('user@spinajs.pl');
      expect(updated.Role, 'role must survive a partial update').to.deep.eq(['user']);
    });

    it('adds new metadata keys', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(user, { Metadata: { 'user:avatar': 'avatar.png' } } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Metadata['user:avatar']).to.eq('avatar.png');
    });

    it('updates an existing metadata key', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(user, { Metadata: { 'user:niceName': 'Renamed User' } } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Metadata['user:niceName']).to.eq('Renamed User');
    });

    it('merges metadata — keys that are not sent are preserved', async () => {
      const user = await byUuid(USER_UUID);

      await usersController.updateUser(user, { Metadata: { 'user:avatar': 'avatar.png' } } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Metadata['user:niceName'], 'unlisted metadata must not be dropped').to.eq('Regular User');
      expect(updated.Metadata['user:phone']).to.eq('123456789');
    });

    it('does not touch other users', async () => {
      const user = await byUuid(USER_UUID);
      await usersController.updateUser(user, { Login: 'renamed' } as any);

      const admin = await byUuid(ADMIN_UUID);
      expect(admin.Login).to.eq('admin');
    });
  });

  describe('Roles', () => {
    it('grants a role, keeping the existing ones', async () => {
      const result = await rolesController.addRole('user', { role: 'admin' } as any);
      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role).to.include.members(['user', 'admin']);
    });

    it('does not duplicate an already granted role', async () => {
      await rolesController.addRole('user', { role: 'user' } as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role.filter((r) => r === 'user')).to.have.lengthOf(1);
    });

    it('revokes a role', async () => {
      await rolesController.addRole('user', { role: 'admin' } as any);
      const result = await rolesController.revokeRole('user', { role: 'admin' } as any);

      expect(result).to.be.instanceOf(Ok);

      const updated = await byUuid(USER_UUID);
      expect(updated.Role).to.not.include('admin');
      expect(updated.Role).to.include('user');
    });

    it('rejects an empty role name', async () => {
      await expect(rolesController.addRole('user', { role: '' } as any)).to.be.rejected;
    });

    it('rejects an unknown user', async () => {
      await expect(rolesController.addRole('i-do-not-exist', { role: 'admin' } as any)).to.be.rejected;
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

    it('deactivates an active account', async () => {
      const user = await byUuid(USER_UUID);

      const result = await securityController.deactivateUser(user);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(USER_UUID)).IsActive).to.eq(false);
    });

    it('activates an inactive account', async () => {
      const user = await byUuid(INACTIVE_UUID);

      const result = await securityController.activateUser(user);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(INACTIVE_UUID)).IsActive).to.eq(true);
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

    it('drops every session of the user on forced logout', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);
      const spy = sinon.stub(sessionProvider, 'deleteByUser').resolves();
      Object.defineProperty(securityController, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });

      const result = await securityController.logoutUser(user);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnceWithExactly(spy, user.Id);
    });
  });

  describe('Profile', () => {
    it('returns the profile of a user identified by login', async () => {
      const result = await profileController.getUserProfile('user');
      const data = await body<any>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(data).to.be.not.undefined;
    });
  });
});

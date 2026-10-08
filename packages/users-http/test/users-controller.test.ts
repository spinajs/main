import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SortOrder } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { FreshAuth } from '@spinajs/authn-http';
import { PaginationDTO, OrderDTO, IFilterRequest, FilterableLogicalOperators } from '@spinajs/orm-http';

import { NO_PASSWORD, PasswordProvider, SessionProvider, User, UserCreated, USER_COMMON_METADATA } from '@spinajs/users';

import { Users } from '../src/admin/controllers/Users/Users.js';
import { Security } from '../src/admin/controllers/Users/Security.js';
import { Profile } from '../src/admin/controllers/Users/Profile.js';

import { globalRolesOf } from './support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, INACTIVE_UUID, USER_UUID, bootAdminWorld, byUuid, registerAdminWorld, signedInPrincipalOf } from './support/admin-world.js';

/**
 * Integration tests for the admin user-management controllers.
 *
 * Controllers are resolved through the real DI container and their handlers are
 * called directly against a real in-memory sqlite database with a real root authz
 * host (test/support/authz-host.ts). Route decorators (@CurrentPrincipal, @Param,
 * @Body, @Query ...) only shape how arguments are produced by the http layer, so the
 * arguments are supplied by hand here: the caller's principal and the addressed uuid.
 * Everything below the handler signature (the per-row decisions, user actions,
 * AuthzAdmin, ORM queries, dehydration, the account guard) is the real thing. Roles
 * are GLOBAL assignments.
 *
 * NOTE: calling handlers directly bypasses @Access and @Body validation, so a test
 * asserting "the DTO rejects X" would prove nothing here. Those live in the
 * route-contract suite and `v3/admin-access.test.ts` instead. The 3.0 role and
 * account guard cases are in `v3/`.
 */

/** Ok/Response keeps its payload and options protected — read them for assertions. */
const body = async <T = any>(r: any): Promise<T> => {
  const data = r.responseData;
  return Array.isArray(data) ? ((await Promise.all(data)) as any) : await data;
};
const headers = (r: any) => (r.options?.Headers ?? []) as Array<{ Name: string; Value: any }>;

const filterReq = (Column: string, Operator: string, Value: any): IFilterRequest => ({ filters: [{ Column, Operator, Value }], op: FilterableLogicalOperators.And }) as any;

describe('Admin user controllers', function () {
  this.timeout(25000);

  let usersController: Users;
  let securityController: Security;
  let profileController: Profile;

  /** queue emit is stubbed everywhere — assertions read events from here */
  let emitStub: sinon.SinonStub;

  before(() => {
    registerAdminWorld();
  });

  beforeEach(async () => {
    const world = await bootAdminWorld();
    usersController = world.users;
    securityController = world.security;
    profileController = world.profile;

    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  const admin = () => signedInPrincipalOf(ADMIN_UUID);

  describe('Users.list', () => {
    it('returns all users with the total count header', async () => {
      const result = await usersController.list(await admin());

      expect(result).to.be.instanceOf(Ok);

      const data = await body<any[]>(result);
      expect(data).to.have.lengthOf(4);

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total).to.be.not.undefined;
      expect(total!.Value).to.eq(4);
    });

    it('never exposes password hashes nor internal ids', async () => {
      const data = await body<any[]>(await usersController.list(await admin()));

      for (const u of data) {
        expect(u.Password, 'password hash leaked').to.be.undefined;
        expect(u.Id, 'internal id leaked').to.be.undefined;
        expect(u.Uuid).to.be.a('string');
      }
    });

    it('paginates', async () => {
      const page0 = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 0, limit: 2 } as any)));
      const page1 = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 1, limit: 2 } as any)));

      expect(page0).to.have.lengthOf(2);
      expect(page1).to.have.lengthOf(2);

      const seen = [...page0, ...page1].map((u: any) => u.Uuid);
      expect(new Set(seen).size, 'pages must not overlap').to.eq(4);
    });

    // Regression: take defaulted the page size to 10 while skip defaulted it to
    // 0, so `page` without `limit` always returned the first page.
    it('honours the page number when no limit is sent', async () => {
      const page0 = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 0 } as any)));
      const page1 = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 1 } as any)));

      expect(page0).to.have.lengthOf(4);
      expect(page1, 'second page of a 4 row table with the default size of 10 is empty').to.have.lengthOf(0);
    });

    it('orders by the requested column', async () => {
      const asc = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 0, limit: 10 } as any), new OrderDTO({ column: 'Login', order: SortOrder.ASC } as any)));

      expect(asc.map((u: any) => u.Login)).to.deep.eq(['admin', 'admin2', 'inactive', 'user']);
    });

    it('rejects a sort column that is not whitelisted', async () => {
      await expect(usersController.list(await admin(), undefined, new OrderDTO({ column: 'Password', order: SortOrder.ASC } as any))).to.be.rejectedWith(/Cannot sort by/);
    });

    it('includes the Metadata relation when asked to', async () => {
      const withMeta = await body<any[]>(await usersController.list(await admin(), undefined, undefined, ['Metadata']));
      const user = withMeta.find((u: any) => u.Login === 'user');

      expect(user.Metadata).to.be.an('array');
      expect(user.Metadata.map((m: any) => m.Key)).to.include.members(['user:niceName', 'user:phone']);
    });

    it('filters by login', async () => {
      const data = await body<any[]>(await usersController.list(await admin(), undefined, undefined, undefined, filterReq('Login', 'eq', 'user')));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('user');
    });

    it('filters by IsActive', async () => {
      const data = await body<any[]>(await usersController.list(await admin(), undefined, undefined, undefined, filterReq('IsActive', 'eq', false)));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('inactive');
    });

    it('filters by the user:niceName metadata column', async () => {
      const data = await body<any[]>(await usersController.list(await admin(), undefined, undefined, undefined, filterReq('user:niceName', 'eq', 'The Admin')));

      expect(data).to.have.lengthOf(1);
      expect(data[0].Login).to.eq('admin');
    });

    it('caps the page size, so the endpoint cannot be turned into a table dump', async () => {
      const pwd = (await DI.resolve(PasswordProvider)) as PasswordProvider;
      const hash = await pwd.hash('bulk1234');

      for (let i = 0; i < 101; i++) {
        await new User({
          Email: `bulk${i}@spinajs.pl`,
          Login: `bulk${i}`,
          Password: hash,
          IsActive: true,
        }).insert();
      }

      const data = await body<any[]>(await usersController.list(await admin(), new PaginationDTO({ page: 0, limit: 1000 } as any)));

      expect(data).to.have.lengthOf(100);
    });

    it('does not leak credential metadata through the listing either', async () => {
      const user = await byUuid(USER_UUID);
      user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN] = 'a-token-worth-stealing';
      await user.Metadata.sync();

      const data = await body<any[]>(await usersController.list(await admin(), undefined, undefined, ['Metadata']));

      expect(JSON.stringify(data)).to.not.include('a-token-worth-stealing');
    });

    it('reports the filtered count, not the table count, in X-Total-Count', async () => {
      const result = await usersController.list(await admin(), undefined, undefined, undefined, filterReq('IsActive', 'eq', true));

      const total = headers(result).find((h) => h.Name === 'X-Total-Count');
      expect(total!.Value).to.eq(3);
    });

    it('filters accounts that never logged in', async () => {
      const user = await byUuid(USER_UUID);
      user.LastLoginAt = DateTime.now();
      await user.update();

      const never = await body<any[]>(await usersController.list(await admin(), undefined, undefined, undefined, filterReq('LastLoginAt', 'isnull', null)));
      expect(never.map((u: any) => u.Login).sort()).to.deep.eq(['admin', 'admin2', 'inactive']);

      const ever = await body<any[]>(await usersController.list(await admin(), undefined, undefined, undefined, filterReq('LastLoginAt', 'notnull', null)));
      expect(ever.map((u: any) => u.Login)).to.deep.eq(['user']);
    });

    it('lists soft-deleted accounts when the request filters on DeletedAt', async () => {
      await usersController.removeUser(await admin(), USER_UUID);

      const live = await usersController.list(await admin());
      expect((await body<any[]>(live)).map((u: any) => u.Login)).to.not.include('user');

      const deleted = await usersController.list(await admin(), undefined, undefined, undefined, filterReq('DeletedAt', 'notnull', null));
      const data = await body<any[]>(deleted);
      expect(data.map((u: any) => u.Login)).to.deep.eq(['user']);
      expect(data[0].DeletedAt).to.be.a('string');
      expect(headers(deleted).find((h) => h.Name === 'X-Total-Count')!.Value).to.eq(1);
    });
  });

  describe('Users.getSingleUser / getByLogin', () => {
    it('returns the user without password or internal id', async () => {
      const data = await body<any>(await usersController.getSingleUser(await admin(), USER_UUID));

      expect(data.Uuid).to.eq(USER_UUID);
      expect(data.Login).to.eq('user');
      expect(data.Password).to.be.undefined;
      expect(data.Id).to.be.undefined;
    });

    it('returns metadata of the user when the relation is populated', async () => {
      const data = await body<any>(await usersController.getByLogin(await admin(), 'user', ['Metadata']));

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

      const data = await body<any>(await usersController.getSingleUser(await admin(), USER_UUID, ['Metadata']));
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
      expect(await globalRolesOf(created.Uuid)).to.include('user');
      expect(created.IsActive, 'new accounts must not be active before confirmation').to.eq(false);
      expect(created.Uuid).to.be.a('string');
    });

    /**
     * Roles are typically switchable profiles one person may legitimately hold
     * several of (a seller working for two companies, an administrator who also
     * edits content), so creation takes a list, granted in one batch.
     */
    it('creates a user holding every role of a list', async () => {
      await usersController.addUser(await admin(), { Login: 'multi', Email: 'multi@spinajs.pl', Role: ['user', 'guest'] } as any);

      const created = await User.query().whereLogin('multi').firstOrFail();
      expect(await globalRolesOf(created.Uuid)).to.have.members(['user', 'guest']);
    });

    it('still accepts a single role name', async () => {
      await usersController.addUser(await admin(), { Login: 'single', Email: 'single@spinajs.pl', Role: 'user' } as any);

      expect(await globalRolesOf((await User.query().whereLogin('single').firstOrFail()).Uuid)).to.deep.equal(['user']);
    });

    // A duplicate would be granted twice in one batch.
    it('trims and de-duplicates the list', async () => {
      await usersController.addUser(await admin(), { Login: 'dedup', Email: 'dedup@spinajs.pl', Role: ['user', ' user ', 'guest'] } as any);

      expect(await globalRolesOf((await User.query().whereLogin('dedup').firstOrFail()).Uuid)).to.have.members(['user', 'guest']);
    });

    // Regression, reported from production:
    //   "Error in controller POST at path /api/users Exception:
    //    users.actions.create.beforeCreate should not be null, undefined or empty"
    // The create action read its middleware lists through a non-nil-checked
    // config helper, so the shipped default (an empty list) — and any app that
    // never declares `users.actions` — made every single user creation fail.
    it('creates a user even though no create middleware is configured', async () => {
      const config = DI.get(Configuration)!;
      config.set('users.actions', undefined);

      const result = await usersController.addUser(await admin(), { Login: 'nomiddleware', Email: 'nomiddleware@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);
      const created = await User.query().whereLogin('nomiddleware').firstOrFail();
      expect(created.Email).to.eq('nomiddleware@spinajs.pl');
    });

    it('creates a user with an explicitly empty create middleware list', async () => {
      const config = DI.get(Configuration)!;
      config.set('users.actions.create.beforeCreate', []);
      config.set('users.actions.create.afterCreate', []);

      const result = await usersController.addUser(await admin(), { Login: 'emptymw', Email: 'emptymw@spinajs.pl', Role: 'user' } as any);

      expect(result).to.be.instanceOf(Ok);
      expect(await User.query().whereLogin('emptymw').firstOrFail()).to.be.not.null;
    });

    it('runs configured beforeCreate middleware', async () => {
      const config = DI.get(Configuration)!;
      config.set('users.actions.create.beforeCreate', [
        (u: User) => {
          u.IsActive = true;
          return u;
        },
      ]);

      await usersController.addUser(await admin(), { Login: 'premade', Email: 'premade@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('premade').firstOrFail();
      expect(created.IsActive).to.eq(true);

      config.set('users.actions.create.beforeCreate', []);
    });

    it('never returns the generated temporary password nor the hash', async () => {
      const result = await usersController.addUser(await admin(), { Login: 'secret', Email: 'secret@spinajs.pl', Role: 'user' } as any);
      const data = await body<any>(result);

      expect(data.Password, 'password must never travel back to the client').to.be.undefined;
      expect(JSON.stringify(data)).to.not.include('Password');
    });

    // users no longer generates a password: the account holds the no-password marker until the owner redeems the invite.
    it('stores no password, never one in plain text', async () => {
      await usersController.addUser(await admin(), { Login: 'hashed', Email: 'hashed@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('hashed').firstOrFail();
      expect(created.Password).to.eq(NO_PASSWORD);
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

    // A soft-deleted row keeps its place in the unique indexes, so reusing its
    // login is a conflict rather than a fresh registration — and used to be a
    // driver error instead of one.
    it('reports a conflict for a login held by a soft-deleted account', async () => {
      await usersController.removeUser(await admin(), USER_UUID);

      await expect(usersController.addUser(await admin(), { Login: 'user', Email: 'reused@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(/already in use/);
    });
  });

  describe('Users.updateUser', () => {
    let freshAuth: sinon.SinonStub;

    // Handlers called directly have no request; fresh auth for e-mail and login changes is pinned over http (identity-change-guard).
    beforeEach(() => {
      freshAuth = sinon.stub(FreshAuth.prototype, 'execute').resolves();
    });

    it('updates login, email and role', async () => {
      const result = await usersController.updateUser(await admin(), USER_UUID, { Login: 'renamed', Email: 'renamed@spinajs.pl', Role: 'admin' } as any, undefined as any);
      expect(result).to.be.instanceOf(Ok);
      expect(freshAuth.calledOnce, 'an e-mail or login change of another account asks fresh auth').to.eq(true);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('renamed');
      expect(updated.Email).to.eq('renamed@spinajs.pl');
      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['admin']);
    });

    it('drops reauthPassword from the DTO, so no later code can copy it into the model', async () => {
      for (const data of [{ Email: 'reauth@spinajs.pl', reauthPassword: 'secret' }, { Role: ['user'], reauthPassword: 'secret' }]) {
        await usersController.updateUser(await admin(), USER_UUID, data as any, undefined as any);
        expect(data).to.not.have.property('reauthPassword');
      }
    });

    it('replaces the whole role list when one is sent', async () => {
      await usersController.updateUser(await admin(), USER_UUID, { Role: ['user', 'guest'] } as any, undefined as any);

      expect(await globalRolesOf(USER_UUID)).to.have.members(['user', 'guest']);
      expect(freshAuth.called, 'a role-only change needs no fresh auth').to.eq(false);
    });

    // The list is a REPLACEMENT, so dropping an entry is a revocation.
    it('revokes the roles a shorter list leaves out', async () => {
      await usersController.updateUser(await admin(), USER_UUID, { Role: ['user', 'guest'] } as any, undefined as any);

      await usersController.updateUser(await admin(), USER_UUID, { Role: ['guest'] } as any, undefined as any);

      expect(await globalRolesOf(USER_UUID)).to.deep.equal(['guest']);
    });

    it('keeps existing values for fields that are not sent', async () => {
      await usersController.updateUser(await admin(), USER_UUID, { Login: 'onlylogin' } as any, undefined as any);

      const updated = await byUuid(USER_UUID);
      expect(updated.Login).to.eq('onlylogin');
      expect(updated.Email, 'email must survive a partial update').to.eq('user@spinajs.pl');
      expect(await globalRolesOf(USER_UUID), 'role must survive a partial update').to.deep.eq(['user']);
    });

    it('rejects a login already taken by another account', async () => {
      await expect(usersController.updateUser(await admin(), USER_UUID, { Login: 'admin' } as any, undefined as any)).to.be.rejectedWith(/already in use/);
    });

    it('accepts a no-op update to the account s own login', async () => {
      const result = await usersController.updateUser(await admin(), USER_UUID, { Login: 'user', Email: 'user@spinajs.pl' } as any, undefined as any);
      expect(result).to.be.instanceOf(Ok);
    });

    it('does not touch other users', async () => {
      await usersController.updateUser(await admin(), USER_UUID, { Login: 'renamed' } as any, undefined as any);

      const adminUser = await byUuid(ADMIN_UUID);
      expect(adminUser.Login).to.eq('admin');
    });
  });

  describe('Users.removeUser / restoreUser', () => {
    it('soft deletes the account and drops its sessions', async () => {
      const user = await byUuid(USER_UUID);
      const sessionProvider = await DI.resolve(SessionProvider);
      const spy = sinon.stub(sessionProvider, 'deleteByUser').resolves();

      const result = await usersController.removeUser(await admin(), USER_UUID);
      expect(result).to.be.instanceOf(Ok);

      const deleted = await User.query().withDeleted().where('Uuid', USER_UUID).first();
      expect(deleted!.DeletedAt, 'row must be kept and stamped').to.be.not.null;
      expect(await User.query().where('Uuid', USER_UUID).first(), 'deleted rows must be invisible to ordinary queries').to.not.exist;

      sinon.assert.calledWith(spy, user.Id);
    });

    it('restores a deleted account without activating it', async () => {
      await usersController.removeUser(await admin(), INACTIVE_UUID);

      const result = await usersController.restoreUser(await admin(), INACTIVE_UUID);
      expect(result).to.be.instanceOf(Ok);

      const restored = await byUuid(INACTIVE_UUID);
      expect(restored.DeletedAt).to.be.null;
      expect(restored.IsActive, 'restoring is not activating').to.eq(false);
    });

    it('refuses to restore an account that is not deleted', async () => {
      await expect(usersController.restoreUser(await admin(), USER_UUID)).to.be.rejectedWith(/is not deleted/);
    });

    it('reports a not found for a uuid that does not exist', async () => {
      await expect(usersController.restoreUser(await admin(), '11111111-2222-4222-8222-333333333333')).to.be.rejectedWith(/not found/);
    });

    it('refuses to delete the caller s own account', async () => {
      const actor = await admin();

      await expect(usersController.removeUser(actor, ADMIN_UUID)).to.be.rejectedWith(/your own account/);
    });
  });

  describe('Account guard', () => {
    it('allows removing an administrator while another one remains', async () => {
      const result = await securityController.deactivateUser(await admin(), ADMIN2_UUID);
      expect(result).to.be.instanceOf(Ok);
    });
  });

  describe('Security', () => {
    it('deactivates an active account', async () => {
      const result = await securityController.deactivateUser(await admin(), USER_UUID);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(USER_UUID)).IsActive).to.eq(false);
    });

    it('refuses to deactivate the caller s own account', async () => {
      const actor = await admin();

      await expect(securityController.deactivateUser(actor, ADMIN_UUID)).to.be.rejectedWith(/your own account/);
    });

    it('activates an inactive account', async () => {
      const result = await securityController.activateUser(await admin(), INACTIVE_UUID);
      expect(result).to.be.instanceOf(Ok);

      expect((await byUuid(INACTIVE_UUID)).IsActive).to.eq(true);
    });

    it('bans and unbans an account', async () => {
      const banned = await securityController.banUser(await admin(), USER_UUID, { reason: 'spam', duration: 3600 } as any);
      expect(banned).to.be.instanceOf(Ok);

      let user = await byUuid(USER_UUID);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.eq(true);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_REASON]).to.eq('spam');
      expect(user.IsBanned).to.eq(true);

      const unbanned = await securityController.unbanUser(await admin(), USER_UUID);
      expect(unbanned).to.be.instanceOf(Ok);

      user = await byUuid(USER_UUID);
      expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.be.null;
      expect(user.IsBanned).to.eq(false);
    });

    it('refuses to ban the caller s own account', async () => {
      const actor = await admin();

      await expect(securityController.banUser(actor, ADMIN_UUID, {} as any)).to.be.rejectedWith(/your own account/);
    });
  });

  describe('Profile', () => {
    it('returns the profile of a user identified by login', async () => {
      const result = await profileController.getUserProfile(await admin(), 'user');
      const data = await body<any>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(data).to.be.not.undefined;

      // Regression: the handler used to hand the pending promise to Ok, which
      // serialized as {} for every client.
      expect(data, 'the profile must be resolved, not a promise').to.not.be.an.instanceOf(Promise);
    });
  });
});

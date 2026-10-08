import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import _ from 'lodash';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzService, GLOBAL, ResourceAdapter } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

import usersConfig from '../src/config/users.js';
import { AuthProvider, MemorySessionStore, SessionProvider, SimpleDbAuthProvider, User, UserMetadata, UserPrincipalFactory, UserResourceAdapter, UserSession } from '../src/index.js';
import { activate, changeUserPassword, create, login, verifyPassword } from '../src/actions.js';
import { InvalidArgument } from '@spinajs/exceptions';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost } from './support/users-db.js';

interface AuthnLegacyKeys {
  checkAuthnLegacyKeys(config: { get<T>(path: string | string[]): T }, log: { warn(message: string): void }): unknown[];
}

/** As the configuration loader merges its files: arrays are concatenated. */
const mergeArrays = (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined);

// The module itself, not the @spinajs/authn barrel: importing the barrel registers authn services and its config
// schema for every suite of this mocha run.
const authnLegacyKeys = (): Promise<AuthnLegacyKeys> => import(pathToFileURL(join(process.cwd(), '..', 'authn', 'lib', 'mjs', 'service', 'boot', 'legacy-keys.js')).href);

const configDir = join(process.cwd(), 'src', 'config');

// authz-http's anonymous principal; users does not depend on authz-http.
const ANONYMOUS: Principal = Object.freeze({ type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: Object.freeze({}) });

async function shippedConfigs(): Promise<[string, Record<string, unknown>][]> {
  const files = readdirSync(configDir).filter((f) => f.endsWith('.ts'));
  return Promise.all(files.map(async (f) => [f, (await import(pathToFileURL(join(configDir, f)).href)).default] as [string, Record<string, unknown>]));
}

function expectNoLegacyRoots(config: Record<string, unknown>, file: string) {
  expect(config, file).to.not.have.any.keys('rbac', 'authn');
}

function getter(values: Record<string, unknown>) {
  return {
    get<T>(path: string | string[]): T {
      return _.get(values, path) as T;
    },
  };
}

describe('the configuration users ships', function () {
  this.timeout(30000);

  it('carries no rbac.* and no authn.* key, in any file of src/config', async () => {
    const configs = await shippedConfigs();

    expect(configs.map(([f]) => f)).to.include('users.ts');
    for (const [file, config] of configs) {
      expectNoLegacyRoots(config, file);
    }
  });

  it('the check above fails when either key is present', () => {
    expect(() => expectNoLegacyRoots({ users: {}, rbac: {} }, 'rbac only')).to.throw();
    expect(() => expectNoLegacyRoots({ users: {}, authn: {} }, 'authn only')).to.throw();
    expect(() => expectNoLegacyRoots({ users: {} }, 'neither')).to.not.throw();
  });

  it('keeps identity keys under users.* and ships no defaultRoles or anonymousRoles array', () => {
    expect(usersConfig.users).to.have.keys(['email', 'user', 'actions']);
    expect(usersConfig.authz.rbac).to.have.keys(['roles']);
  });

  it("passes authn's legacy-key detector with authn.config.rejectLegacyKeys on", async () => {
    const { checkAuthnLegacyKeys } = await authnLegacyKeys();
    const warnings: string[] = [];
    const merged = _.mergeWith({}, usersConfig, { authn: { config: { rejectLegacyKeys: true } } }, mergeArrays);

    expect(checkAuthnLegacyKeys(getter(merged), { warn: (m: string) => warnings.push(m) })).to.deep.eq([]);
    expect(warnings).to.deep.eq([]);

    // The detector is live: the 2.x lockout key users used to ship fails the same boot.
    const legacy = _.mergeWith({}, merged, { rbac: { password: { blockAfterAttempts: 5 } } }, mergeArrays);
    expect(() => checkAuthnLegacyKeys(getter(legacy), { warn: () => undefined })).to.throw(/rbac\.password\.blockAfterAttempts/);
  });

  describe('the deprecated 2.x code, without the authn keys users used to ship', () => {
    before(() => {
      registerUsersTestHost();
    });

    // What an application gets now: the authn packages' 3.0 shapes (objects without a 2.x service), no rbac tree.
    const authnShapes = (config: Configuration) => {
      config.set('authn.local', { hasher: { maxConcurrent: 8 }, policy: { minLength: 8, maxLength: 128, blocklist: null } });
      config.set('authn.session', { pendingTtlSeconds: 300 });
      config.set('rbac', undefined);
    };

    afterEach(() => {
      sinon.restore();
      DI.clearCache();
    });

    it('logs in, verifies and changes a password through the 2.x defaults', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
      await bootUsersDb(authnShapes);

      const provider = (await DI.resolve(AuthProvider)) as SimpleDbAuthProvider;
      expect(provider).to.be.instanceOf(SimpleDbAuthProvider);
      const user = await provider.authenticate('test@spinajs.pl', 'bbbb');
      expect(user.Uuid).to.eq(TEST_USER_UUID);

      expect(await login('test@spinajs.pl', 'bbbb')).to.have.property('Uuid', TEST_USER_UUID);
      expect(await verifyPassword(user, 'bbbb')).to.eq(true);

      await expect(changeUserPassword(user, 'short')).to.be.rejectedWith(InvalidArgument);
      await changeUserPassword(user, 'n3wpassword');
      expect(await verifyPassword(await User.query().where('Uuid', TEST_USER_UUID).firstOrFail(), 'n3wpassword')).to.eq(true);
    });

    it('builds the legacy session store with the 2.x expiration', async () => {
      await bootUsersDb(authnShapes);

      const store = (await DI.resolve(SessionProvider)) as MemorySessionStore;
      const session = new UserSession({ UserId: 1 });
      await store.save(session);

      expect(store).to.be.instanceOf(MemorySessionStore);
      expect(session.Expiration).to.not.eq(undefined);
    });
  });

  describe('roles, booted in a real root authz host', () => {
    before(() => {
      registerUsersTestHost();
    });

    beforeEach(async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);

      // As an application would load it: users' fragment merged with the application's roles, the ones the test
      // fixtures use. No 2.x rbac tree, and both legacy-key detectors fail the boot.
      await bootUsersDb((config: Configuration) => {
        const roles = _.mergeWith({}, config.get('authz.rbac.roles'), usersConfig.authz.rbac.roles, mergeArrays);
        config.set('authz.rbac.roles', roles);
        config.set('authz.rbac.anonymousRoles', ['guest']);
        config.set('rbac', undefined);
        config.set('authz.config', { rejectLegacyKeys: true });
        config.set('authn.config', { rejectLegacyKeys: true });
      });
    });

    afterEach(() => {
      sinon.restore();
      DI.clearCache();
    });

    it('compiles them; UserResourceAdapter declares the user permissions they name', async () => {
      expect(await DI.resolve(AuthzService)).to.be.instanceOf(AuthzService);

      const chain = (await DI.RootContainer.resolve(Array.chainOf(ResourceAdapter))) as ResourceAdapter[];
      const adapter = chain.find((a) => a instanceof UserResourceAdapter)!;
      expect(adapter.permissions!()).to.deep.eq([
        { name: 'user:read', resource: 'user', action: 'read', types: ['user'], fields: true },
        { name: 'user:update', resource: 'user', action: 'update', types: ['user'], fields: true },
        { name: 'user:impersonate', resource: 'user', action: 'impersonate', types: ['user'] },
        { name: 'user.metadata:read', resource: 'user.metadata', action: 'read', types: ['user.metadata'] },
        { name: 'user.metadata:create', resource: 'user.metadata', action: 'create', types: ['user.metadata'] },
        { name: 'user.metadata:update', resource: 'user.metadata', action: 'update', types: ['user.metadata'] },
        { name: 'user.metadata:delete', resource: 'user.metadata', action: 'delete', types: ['user.metadata'] },
        { name: 'users:credentials', resource: 'users', action: 'credentials', types: ['users'] },
      ]);
    });

    it('registers users:credentials, which admin.users holds at GLOBAL through users:*; a plain user does not', async () => {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
      // The fixture test user holds admin, which extends admin.users (seeded by the test migration).
      const admin = await factory.principalOf(await User.query().where('Uuid', TEST_USER_UUID).populate('Metadata').firstOrFail());
      const { User: plain } = await create({ Email: 'credentials-plain@spinajs.pl', Login: 'credentials-plain', Password: 'passw0rd123' }, ['user']);
      await activate(plain);
      const me = await factory.principalOf(await User.query().where('Uuid', plain.Uuid).populate('Metadata').firstOrFail());

      expect(await authz.can(admin, 'users:credentials', GLOBAL)).to.eq(true);
      expect(await authz.can(me, 'users:credentials', GLOBAL)).to.eq(false);
    });

    it("gives a user its own metadata rows through 'owner' and not another user's; admin.users any row, unconditionally", async () => {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
      const { User: plain } = await create({ Email: 'metadata-owner@spinajs.pl', Login: 'metadata-owner', Password: 'passw0rd123' }, ['user']);
      await activate(plain);
      const own = await User.query().where('Uuid', plain.Uuid).populate('Metadata').firstOrFail();
      // The fixture test user holds admin (seeded by the test migration).
      const other = await User.query().where('Uuid', TEST_USER_UUID).populate('Metadata').firstOrFail();
      const me = await factory.principalOf(own);
      const admin = await factory.principalOf(other);
      const entryOf = (user: User) => Object.assign(new UserMetadata(), { Key: 'user:note', Value: 'x', Type: 'string', user_id: user.Id });

      for (const action of ['read', 'create', 'update', 'delete']) {
        const permission = `user.metadata:${action}`;

        const typeLevel = await authz.check({ principal: me, permission, resource: { type: 'user.metadata' } });
        expect(typeLevel.allowed, permission).to.eq(true);
        expect(typeLevel.residual, permission).to.deep.eq({ op: 'relation', relation: 'owner' });
        expect(await authz.can(me, permission, { type: 'user.metadata' }, entryOf(own)), permission).to.eq(true);
        expect(await authz.can(me, permission, { type: 'user.metadata' }, entryOf(other)), permission).to.eq(false);

        const any = await authz.check({ principal: admin, permission, resource: { type: 'user.metadata' } });
        expect(any.allowed && any.residual.op, permission).to.eq('true');
      }
    });

    it('gives admin user:impersonate through the fragment, and a user its own row with the 2.x fields', async () => {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;

      // The fixture test user holds admin (seeded by the test migration).
      const admin = await factory.principalOf(await User.query().where('Uuid', TEST_USER_UUID).populate('Metadata').firstOrFail());
      expect(await authz.can(admin, 'user:impersonate')).to.eq(true);

      const { User: plain } = await create({ Email: 'fragment@spinajs.pl', Login: 'fragment', Password: 'passw0rd123' }, ['user']);
      await activate(plain);
      const own = await User.query().where('Uuid', plain.Uuid).populate('Metadata').firstOrFail();
      const other = await User.query().where('Uuid', TEST_USER_UUID).firstOrFail();
      const me = await factory.principalOf(own);

      const read = await authz.check({ principal: me, permission: 'user:read', resource: { type: 'user', id: own.Uuid }, subject: own });
      expect(read.allowed).to.eq(true);
      expect(read.fields.read).to.have.members(['Email', 'Login']);

      const write = await authz.check({ principal: me, permission: 'user:update', resource: { type: 'user', id: own.Uuid }, subject: own });
      expect(write.allowed).to.eq(true);
      // authz.fields.neverRead (default ['Password']) takes Password out of every decision: it changes through PasswordService.
      expect(write.fields.write).to.have.members(['Email', 'Login']);

      expect(await authz.can(me, 'user:read', { type: 'user', id: other.Uuid }, other)).to.eq(false);
      expect(await authz.can(me, 'user:impersonate')).to.eq(false);
    });

    /** `user:read` of an account holding `roles` on its own row: the check's fields and its summary entry's. */
    const ownRead = async (roles: string[], login: string) => {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
      const { User: created } = await create({ Email: `${login}@spinajs.pl`, Login: login, Password: 'passw0rd123' }, roles);
      await activate(created);
      const own = await User.query().where('Uuid', created.Uuid).populate('Metadata').firstOrFail();
      const principal = await factory.principalOf(own);
      const read = await authz.check({ principal, permission: 'user:read', resource: { type: 'user', id: own.Uuid }, subject: own });
      expect(read.allowed, login).to.eq(true);
      const summary = (await authz.summary(principal)).permissions.find((p) => p.name === 'user:read');
      return { check: read.fields.read, summary: summary?.fields?.read };
    };

    it('gives a guest-only account its own Login and not its Email, in a check and in the summary', async () => {
      const fields = await ownRead(['guest'], 'guest-only');

      expect(fields.check).to.have.members(['Login']);
      expect(fields.summary).to.have.members(['Login']);
    });

    it('gives a user account its own Email and Login, in a check and in the summary', async () => {
      const fields = await ownRead(['user'], 'user-only');

      expect(fields.check).to.have.members(['Email', 'Login']);
      expect(fields.summary).to.have.members(['Email', 'Login']);
    });

    it('RFC C3-1: an account holding guest and user reads its own row with Email and Login (union: both grants are on self)', async () => {
      const fields = await ownRead(['guest', 'user'], 'guest-and-user');

      expect(fields.check).to.have.members(['Email', 'Login']);
      expect(fields.summary).to.have.members(['Email', 'Login']);
    });

    it("gives the anonymous principal (anonymousRoles guest) no other user's Email", async () => {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const other = await User.query().where('Uuid', TEST_USER_UUID).firstOrFail();

      const read = await authz.check({ principal: ANONYMOUS, permission: 'user:read', resource: { type: 'user', id: other.Uuid }, subject: other });
      expect(read.allowed).to.eq(false);
      const summary = (await authz.summary(ANONYMOUS)).permissions.find((p) => p.name === 'user:read');
      expect(summary?.fields?.read ?? []).to.not.include('Email');
    });
  });
});

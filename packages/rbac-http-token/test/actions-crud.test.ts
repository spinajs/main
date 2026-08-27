import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, create } from '@spinajs/rbac';
import { ErrorCode } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import { E_TOKEN_CODES, createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../src/actions.js';
import '../src/generator.js';
import '../src/role-policy.js';

/**
 * Answers whatever a test told it to, per profile. The `''` key holds the
 * profile-less answer, so a test can make the owner-wide union and the
 * profile-relative set differ - the only way to prove the actions validate
 * against the PROFILE rather than against everything the owner may ever carry.
 *
 * Selected by name through `rbac.token.rolePolicy.service`, so only the nested
 * `profiles` block below runs against it; the rest of this suite keeps the
 * shipped `OwnRolesTokenRolePolicy`.
 */
@Injectable(AccessTokenRolePolicy)
class CrudProfileStubPolicy extends AccessTokenRolePolicy {
  public static Profiles: string[] = [];
  public static RolesPerProfile: Record<string, string[]> = {};

  public async allowedRoles(_owner: User, profile?: string): Promise<string[]> {
    return [...(CrudProfileStubPolicy.RolesPerProfile[profile ?? ''] ?? [])];
  }

  public async allowedProfiles(_owner: User): Promise<string[]> {
    return [...CrudProfileStubPolicy.Profiles];
  }
}

describe('access token actions - crud', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    // rbac wires its AccessControl instance and user factories from a
    // bootstrapper; nothing runs bootstrappers for us outside a real app.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  it('creates token for user, returns plaintext once, stores only hash', async () => {
    const { User: owner } = await create('c1@spinajs.com', 'c1', ['user', 'admin'], { password: 'password123' });

    const { Token, Plaintext } = await createToken(owner, 'ci token', ['user'], null);

    expect(Plaintext).to.match(/^spt_/);
    expect(Token.Uuid).to.be.a('string');
    expect(Token.Roles).to.deep.equal(['user']);
    expect(Token.ExpiresAt).to.be.null;

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Token).to.have.length(64);
    expect(row.Token).to.not.contain(Plaintext);
    expect(row.user_id).to.equal(owner.Id);
  });

  it('accepts expiration date', async () => {
    const { User: owner } = await create('c2@spinajs.com', 'c2', ['user'], { password: 'password123' });
    const expires = DateTime.now().plus({ days: 7 });

    const { Token } = await createToken(owner, 'temp', ['user'], expires);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.ExpiresAt?.toISODate()).to.equal(expires.toISODate());
  });

  it('rejects roles the owner does not hold', async () => {
    const { User: owner } = await create('c3@spinajs.com', 'c3', ['user'], { password: 'password123' });

    // the role-subset rule is a security invariant, so assert the exact
    // failure - "rejected somehow" would also pass on an unrelated crash
    const err = await createToken(owner, 'bad', ['admin'], null).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

    // nothing may be persisted by a refused create
    const rows = await AccessToken.where('Name', 'bad').all();
    expect(rows).to.have.length(0);
  });

  it('resolves owner by uuid string', async () => {
    const { User: owner } = await create('c4@spinajs.com', 'c4', ['user'], { password: 'password123' });
    const { Token } = await createToken(owner.Uuid, 'by uuid', ['user'], null);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.user_id).to.equal(owner.Id);
  });

  it('deletes token by uuid', async () => {
    const { User: owner } = await create('c5@spinajs.com', 'c5', ['user'], { password: 'password123' });
    const { Token } = await createToken(owner, 'to delete', ['user'], null);

    await deleteToken(Token.Uuid);
    const row = await AccessToken.where('Uuid', Token.Uuid).first();
    expect(row).to.be.undefined;
  });

  it('grants and revokes role on token, only owner-held roles grantable', async () => {
    const { User: owner } = await create('c6@spinajs.com', 'c6', ['user', 'admin'], { password: 'password123' });
    const { Token } = await createToken(owner, 'roles', ['user'], null);

    const granted = await grantTokenRole(Token.Uuid, 'admin');
    expect(granted.Roles).to.have.members(['user', 'admin']);

    const revoked = await revokeTokenRole(Token.Uuid, 'user');
    expect(revoked.Roles).to.deep.equal(['admin']);

    // the returned instance proves the in-memory mutation, not the write -
    // reload to prove the revoke actually reached the row
    const reloaded = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(reloaded.Roles).to.deep.equal(['admin']);

    const err = await grantTokenRole(Token.Uuid, 'system').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
  });

  it('refuses to revoke the last role, leaving the row untouched', async () => {
    const { User: owner } = await create('c7@spinajs.com', 'c7', ['user'], { password: 'password123' });
    const { Token } = await createToken(owner, 'single role', ['user'], null);

    const err = await revokeTokenRole(Token.Uuid, 'user').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

    // an empty @Set() column stores as '' and reads back as [''] - a phantom
    // role that survives every later grant, so the refusal must be total
    const reloaded = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(reloaded.Roles).to.deep.equal(['user']);
  });

  describe('profiles', () => {
    before(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'CrudProfileStubPolicy');

      // `_allowed_roles` drops every role AccessControl does not know about, so
      // the role used to prove profile narrowing has to be in the grants map -
      // otherwise the refusals below would pass for the wrong reason. What it
      // grants is irrelevant here; only its presence in the map is.
      const ac = DI.get<AccessControl>('AccessControl')!;
      ac.grant('extra').readOwn('extra');
    });

    after(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'OwnRolesTokenRolePolicy');
    });

    beforeEach(() => {
      CrudProfileStubPolicy.Profiles = ['admin'];
      CrudProfileStubPolicy.RolesPerProfile = { '': ['user', 'extra'], admin: ['user'] };
    });

    it('createToken stores the profile when the policy allows it', async () => {
      const { User: owner } = await create('c8@spinajs.com', 'c8', ['user'], { password: 'password123' });

      const { Token } = await createToken(owner, 'profiled', ['user'], null, 'admin');

      expect(Token.Profile).to.equal('admin');

      // the pin is what later requests are scoped by, so it has to reach the row
      const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
      expect(row.Profile).to.equal('admin');
    });

    it('createToken refuses a profile the policy does not allow', async () => {
      const { User: owner } = await create('c9@spinajs.com', 'c9', ['user'], { password: 'password123' });

      const err = await createToken(owner, 'bad-profile', ['user'], null, 'not-a-profile').catch((e: unknown) => e);
      expect(err).to.be.instanceOf(ErrorCode);
      expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

      // nothing may be persisted by a refused create
      const rows = await AccessToken.where('Name', 'bad-profile').all();
      expect(rows).to.have.length(0);
    });

    it('createToken validates roles against the profile, not the owner union', async () => {
      const { User: owner } = await create('c10@spinajs.com', 'c10', ['user'], { password: 'password123' });

      // control: with no profile 'extra' is allowed, so the refusal below can
      // only come from the profile-relative answer
      const { Token } = await createToken(owner, 'wide', ['extra'], null);
      expect(Token.Roles).to.deep.equal(['extra']);

      const err = await createToken(owner, 'narrowed', ['extra'], null, 'admin').catch((e: unknown) => e);
      expect(err).to.be.instanceOf(ErrorCode);
      expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
      expect((err as ErrorCode).data).to.deep.equal({ roles: ['extra'] });
    });

    it('grantTokenRole validates against the profile the token is pinned to', async () => {
      const { User: owner } = await create('c11@spinajs.com', 'c11', ['user'], { password: 'password123' });
      const { Token } = await createToken(owner, 'pinned', ['user'], null, 'admin');

      // granting reloads the token by uuid, so this also proves the pin
      // round-trips through the row rather than living on the instance only
      const err = await grantTokenRole(Token.Uuid, 'extra').catch((e: unknown) => e);
      expect(err).to.be.instanceOf(ErrorCode);
      expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

      const reloaded = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
      expect(reloaded.Roles).to.deep.equal(['user']);
    });
  });
});

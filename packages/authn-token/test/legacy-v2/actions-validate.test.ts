import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create, revoke } from '@spinajs/users';
import { AccessTokenRoleNotAllowed } from '../../src/legacy/exceptions.js';

import { DbTestConfiguration } from '../db-common.js';
import { AccessTokenRolePolicy } from '../../src/legacy/interfaces.js';
import { createToken, validateToken } from '../../src/legacy/actions.js';
import '../../src/generator.js';
import '../../src/legacy/role-policy.js';

/**
 * Same shape as the stub in `actions-crud.test.ts` ( different class name -
 * the DI registry de-duplicates by type name ): answers per profile, with the
 * `''` key holding the profile-less answer, so a test can narrow what a profile
 * covers after a token was already minted under it.
 */
@Injectable(AccessTokenRolePolicy)
class ValidateProfileStubPolicy extends AccessTokenRolePolicy {
  public static Profiles: string[] = [];
  public static RolesPerProfile: Record<string, string[]> = {};

  public async allowedRoles(_owner: User, profile?: string): Promise<string[]> {
    return [...(ValidateProfileStubPolicy.RolesPerProfile[profile ?? ''] ?? [])];
  }

  public async allowedProfiles(_owner: User): Promise<string[]> {
    return [...ValidateProfileStubPolicy.Profiles];
  }
}

describe('access token actions - validate & cleanup', function () {
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

  /**
   * `create` leaves the account inactive - validation refuses inactive owners,
   * so every fixture user here has to be activated first.
   */
  async function activeUser(mail: string, login: string, roles: string[]) {
    const { User: u } = await create(mail, login, roles, { password: 'password123' });
    await activate(u.Id);
    return u;
  }

  it('validates a good token and returns effective roles', async () => {
    const owner = await activeUser('v1@spinajs.com', 'v1', ['user', 'admin']);
    const { Plaintext } = await createToken(owner, 'good', ['user'], null);

    const result = await validateToken(Plaintext);
    expect(result.User.Id).to.equal(owner.Id);
    expect(result.Token.Name).to.equal('good');
    // the token narrows its owner - 'admin' is held by the user but not carried
    // by the token, so it must not show up in the effective set
    expect(result.EffectiveRoles).to.deep.equal(['user']);
  });

  it('effective roles shrink when user loses a role', async () => {
    const owner = await activeUser('v6@spinajs.com', 'v6', ['user', 'admin']);
    const { Plaintext } = await createToken(owner, 'shrink', ['user', 'admin'], null);

    await revoke(owner.Id, 'admin');

    const result = await validateToken(Plaintext);
    expect(result.EffectiveRoles).to.deep.equal(['user']);
  });

  it('rejects when intersection is empty', async () => {
    // the token keeps every role it was created with; the owner loses the only
    // one they had in common. Revoking on the token itself cannot produce this
    // state - it refuses to empty the role list.
    const owner = await activeUser('v7@spinajs.com', 'v7', ['user', 'admin']);
    const { Plaintext } = await createToken(owner, 'empty intersection', ['admin'], null);

    await revoke(owner.Id, 'admin');

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenRoleNotAllowed);
  });

  describe('profiles', () => {
    before(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'ValidateProfileStubPolicy');

      // `_allowed_roles` drops every role AccessControl does not know about, so
      // 'extra' has to be in the grants map for the narrowing below to mean
      // anything. What it grants is irrelevant here; only its presence is.
      const ac = DI.get<AccessControl>('AccessControl')!;
      ac.grant('extra').readOwn('extra');
    });

    after(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'OwnRolesTokenRolePolicy');
    });

    beforeEach(() => {
      ValidateProfileStubPolicy.Profiles = ['admin'];
      ValidateProfileStubPolicy.RolesPerProfile = { '': ['user', 'extra'], admin: ['user', 'extra'] };
    });

    it('rejects a token whose profile the owner no longer passes', async () => {
      const owner = await activeUser('v11@spinajs.com', 'v11', ['user']);
      const { Plaintext } = await createToken(owner, 'profiled', ['user'], null, 'admin');

      // the policy stops offering the profile - a role revoked, a policy
      // tightened - and the pinned token has to stop authorising at once,
      // exactly as a revoked role does
      ValidateProfileStubPolicy.Profiles = [];

      const err = await validateToken(Plaintext).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(AccessTokenRoleNotAllowed);
    });

    it('intersects effective roles against the profile-relative allowed set', async () => {
      const owner = await activeUser('v12@spinajs.com', 'v12', ['user']);
      const { Plaintext } = await createToken(owner, 'profiled roles', ['user', 'extra'], null, 'admin');

      // the profile now covers fewer roles than the token carries, while the
      // owner-wide union still covers both - proving the intersection is taken
      // against the PROFILE answer
      ValidateProfileStubPolicy.RolesPerProfile = { '': ['user', 'extra'], admin: ['user'] };

      const result = await validateToken(Plaintext);
      expect(result.EffectiveRoles).to.deep.equal(['user']);
      expect(result.Token.Profile).to.equal('admin');
    });

    it('leaves a legacy token without a profile untouched by the profile gate', async () => {
      const owner = await activeUser('v13@spinajs.com', 'v13', ['user']);
      const { Plaintext } = await createToken(owner, 'legacy', ['extra'], null);

      // no profile is offered at all, which must not affect a token that never
      // carried one
      ValidateProfileStubPolicy.Profiles = [];

      const result = await validateToken(Plaintext);
      expect(result.EffectiveRoles).to.deep.equal(['extra']);
      expect(result.Token.Profile).to.not.be.ok;
    });
  });
});

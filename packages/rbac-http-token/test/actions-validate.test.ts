import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, ban, create, deactivate, deleteUser, revoke } from '@spinajs/rbac';
import { ErrorCode } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import { E_TOKEN_CODES, createToken, deleteExpiredTokens, touchToken, validateToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/role-policy.js';

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
    const { User: u } = await create(mail, login, 'password123', roles);
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

  it('rejects unknown token', async () => {
    const err = await validateToken('spt_does-not-exist').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_NOT_FOUND);
  });

  it('rejects degenerate input as an unknown token', async () => {
    // empty / whitespace / nil must not escape as InvalidArgument or TypeError -
    // callers catch ErrorCode and would let a raw throw become a 500 instead of
    // a 401. The code is deliberately the same as for a wrong token.
    for (const bad of ['', '   ', undefined, null]) {
      const err = await validateToken(bad as unknown as string).catch((e: unknown) => e);
      expect(err, `input: ${JSON.stringify(bad)}`).to.be.instanceOf(ErrorCode);
      expect((err as ErrorCode).code, `input: ${JSON.stringify(bad)}`).to.equal(E_TOKEN_CODES.E_TOKEN_NOT_FOUND);
    }
  });

  it('rejects expired token', async () => {
    const owner = await activeUser('v2@spinajs.com', 'v2', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'expired', ['user'], DateTime.now().plus({ minutes: 5 }));

    // move expiry into the past directly in db
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_EXPIRED);
  });

  it('infinite token (null expiry) validates', async () => {
    const owner = await activeUser('v3@spinajs.com', 'v3', ['user']);
    const { Plaintext } = await createToken(owner, 'infinite', ['user'], null);
    await expect(validateToken(Plaintext)).to.be.fulfilled;
  });

  it('rejects token of deactivated owner', async () => {
    const owner = await activeUser('v4@spinajs.com', 'v4', ['user']);
    const { Plaintext } = await createToken(owner, 'inactive owner', ['user'], null);
    await deactivate(owner.Id);

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_OWNER_INVALID);
  });

  it('rejects token of soft-deleted owner', async () => {
    const owner = await activeUser('v10@spinajs.com', 'v10', ['user']);
    const { Plaintext } = await createToken(owner, 'deleted owner', ['user'], null);

    // `deleteUser` soft-deletes, so the token row outlives its owner - the owner
    // lookup has to refuse it rather than hand back a tombstoned account
    await deleteUser(owner.Id);

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_OWNER_INVALID);
  });

  it('rejects token of banned owner', async () => {
    const owner = await activeUser('v5@spinajs.com', 'v5', ['user']);
    const { Plaintext } = await createToken(owner, 'banned owner', ['user'], null);
    await ban(owner.Id, 'test', 3600);

    // a ban lives in user metadata, so this also proves validation loads the
    // owner with Metadata populated - without it IsBanned is always false
    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_OWNER_INVALID);
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
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
  });

  /**
   * The sweep is a bulk DELETE driven by two predicates that are easy to get
   * wrong in opposite directions: dropping `whereNotNull` would take every
   * never-expiring token with it, and comparing the wrong way round would take
   * every token that is still valid. Both survivors are therefore asserted
   * explicitly - a null expiry AND a future one.
   *
   * The db is shared with the rest of this file, so the deleted COUNT cannot be
   * pinned exactly; the three rows this test owns can be, and are.
   */
  it('deleteExpiredTokens removes only expired rows', async () => {
    const owner = await activeUser('v8@spinajs.com', 'v8', ['user']);
    const { Token: live } = await createToken(owner, 'live', ['user'], null);
    const { Token: future } = await createToken(owner, 'future', ['user'], DateTime.now().plus({ days: 30 }));
    const { Token: dead } = await createToken(owner, 'dead', ['user'], DateTime.now().plus({ minutes: 5 }));

    const row = await AccessToken.where('Uuid', dead.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const count = await deleteExpiredTokens();
    expect(count).to.be.gte(1);
    expect(await AccessToken.where('Uuid', live.Uuid).first(), 'a never-expiring token was swept away').to.not.be.undefined;
    expect(await AccessToken.where('Uuid', future.Uuid).first(), 'a token expiring in the future was swept away').to.not.be.undefined;
    expect(await AccessToken.where('Uuid', dead.Uuid).first()).to.be.undefined;

    // and this owner is left with exactly the two survivors - nothing of theirs
    // was taken beyond the one expired row
    const remaining = await AccessToken.where('user_id', owner.Id);
    expect(remaining.map((t) => t.Name)).to.have.members(['live', 'future']);
  });

  it('touchToken stamps first use and then throttles writes', async () => {
    const owner = await activeUser('v9@spinajs.com', 'v9', ['user']);
    const { Token } = await createToken(owner, 'touch', ['user'], null);

    await touchToken(Token, 60);
    const stamped = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(stamped.LastUsedAt).to.be.instanceOf(DateTime);

    // inside the throttle window nothing is written - the untouched in-memory
    // stamp is the proof, an update() would have overwritten it with now()
    const recent = DateTime.now().minus({ seconds: 5 });
    Token.LastUsedAt = recent;
    await touchToken(Token, 60);
    expect(Token.LastUsedAt.toMillis()).to.equal(recent.toMillis());

    // outside the window it writes again
    Token.LastUsedAt = DateTime.now().minus({ seconds: 120 });
    await touchToken(Token, 60);
    expect(Token.LastUsedAt.toMillis()).to.be.gt(recent.toMillis());
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
      expect(err).to.be.instanceOf(ErrorCode);
      expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
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

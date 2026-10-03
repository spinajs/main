import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, activate, create } from '@spinajs/users';
import { AccessTokenNotFound } from '../src/legacy/exceptions.js';
import { FakeIdentityStore } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, deleteExpiredTokens, touchToken, validateToken } from '../src/legacy/actions.js';
import { DbTokenService, NoTokenProfilesPolicy, UsersTableTokenOwnerResolver } from '../src/service/index.js';
import '../src/generator.js';
import '../src/legacy/role-policy.js';

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

  // Both look like an unknown token, so a caller cannot probe which rows exist.
  it('rejects a revoked token as an unknown token', async () => {
    const owner = await activeUser('v11@spinajs.com', 'v11', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'revoked', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.RevokedAt = DateTime.now();
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  it('rejects a 3.0 agent token as an unknown token', async () => {
    const owner = await activeUser('v12@spinajs.com', 'v12', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'agent', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.Kind = 'agent';
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  it('rejects a 3.0 service token as an unknown token', async () => {
    const owner = await activeUser('v13@spinajs.com', 'v13', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'service', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.Kind = 'service';
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  // The 2.x path cannot honour scope limits, so it would widen the token to its full roles.
  for (const [n, label, scope] of [
    [1, 'permissions', { permissions: ['file:read'] }],
    [2, 'resources', { resources: [{ type: 'file', id: '7' }] }],
    [3, 'permissions to none', { permissions: [] }],
  ] as const) {
    it(`rejects a token with a scope limiting ${label} as an unknown token`, async () => {
      const owner = await activeUser(`v14-${n}@spinajs.com`, `v14-${n}`, ['user']);
      const { Token, Plaintext } = await createToken(owner, 'scoped', ['user'], null);

      const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
      row.Scope = scope;
      await row.update();

      const err = await validateToken(Plaintext).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(AccessTokenNotFound);
      expect((err as Error).message).to.equal('Access token not found');
    });
  }

  it('createToken stores Kind pat in the column', async () => {
    const owner = await activeUser('v15@spinajs.com', 'v15', ['user']);
    const { Token } = await createToken(owner, 'kind', ['user'], null);

    const rows = (await DI.get(Orm)!.Connections.get('sqlite')!.select().from('rbac_access_tokens').where({ Uuid: Token.Uuid })) as Array<{ Kind: string }>;
    expect(rows[0].Kind).to.equal('pat');
  });

  it('a token minted through createToken validates through DbTokenService and lists as a pat', async () => {
    const owner = await activeUser('v16@spinajs.com', 'v16', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'cross', ['user'], DateTime.now().plus({ days: 1 }));

    const identities = new FakeIdentityStore();
    const ref = identities.add({ login: 'v16', id: owner.Uuid });
    const tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities);
    const now = new Date();

    const result = await tokens.validate(Plaintext, { now, purpose: 'request' });
    expect(result.ok).to.equal(true);
    expect(result.ok && result.identity).to.deep.equal(ref);
    expect(result.ok && result.ceiling).to.deep.equal({ roles: ['user'] });

    const listed = await tokens.list(ref);
    expect(listed.map((r) => [r.id, r.kind])).to.deep.equal([[Token.Uuid, 'pat']]);
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
});

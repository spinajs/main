import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, activate, ban, create, deactivate, revoke } from '@spinajs/rbac';
import { ErrorCode } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { E_CODES, createToken, deleteExpiredTokens, touchToken, validateToken } from '../src/actions.js';
import '../src/generator.js';

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
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_NOT_FOUND);
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
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_EXPIRED);
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
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_OWNER_INVALID);
  });

  it('rejects token of banned owner', async () => {
    const owner = await activeUser('v5@spinajs.com', 'v5', ['user']);
    const { Plaintext } = await createToken(owner, 'banned owner', ['user'], null);
    await ban(owner.Id, 'test', 3600);

    // a ban lives in user metadata, so this also proves validation loads the
    // owner with Metadata populated - without it IsBanned is always false
    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_OWNER_INVALID);
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
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
  });

  it('deleteExpiredTokens removes only expired rows', async () => {
    const owner = await activeUser('v8@spinajs.com', 'v8', ['user']);
    const { Token: live } = await createToken(owner, 'live', ['user'], null);
    const { Token: dead } = await createToken(owner, 'dead', ['user'], DateTime.now().plus({ minutes: 5 }));

    const row = await AccessToken.where('Uuid', dead.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const count = await deleteExpiredTokens();
    expect(count).to.be.gte(1);
    expect(await AccessToken.where('Uuid', live.Uuid).first()).to.not.be.undefined;
    expect(await AccessToken.where('Uuid', dead.Uuid).first()).to.be.undefined;
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

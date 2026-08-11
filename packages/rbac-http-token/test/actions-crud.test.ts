import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create } from '@spinajs/rbac';
import { ErrorCode } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { E_CODES, createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../src/actions.js';
import '../src/generator.js';

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
    const { User: owner } = await create('c1@spinajs.com', 'c1', 'password123', ['user', 'admin']);

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
    const { User: owner } = await create('c2@spinajs.com', 'c2', 'password123', ['user']);
    const expires = DateTime.now().plus({ days: 7 });

    const { Token } = await createToken(owner, 'temp', ['user'], expires);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.ExpiresAt?.toISODate()).to.equal(expires.toISODate());
  });

  it('rejects roles the owner does not hold', async () => {
    const { User: owner } = await create('c3@spinajs.com', 'c3', 'password123', ['user']);

    // the role-subset rule is a security invariant, so assert the exact
    // failure - "rejected somehow" would also pass on an unrelated crash
    const err = await createToken(owner, 'bad', ['admin'], null).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

    // nothing may be persisted by a refused create
    const rows = await AccessToken.where('Name', 'bad').all();
    expect(rows).to.have.length(0);
  });

  it('resolves owner by uuid string', async () => {
    const { User: owner } = await create('c4@spinajs.com', 'c4', 'password123', ['user']);
    const { Token } = await createToken(owner.Uuid, 'by uuid', ['user'], null);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.user_id).to.equal(owner.Id);
  });

  it('deletes token by uuid', async () => {
    const { User: owner } = await create('c5@spinajs.com', 'c5', 'password123', ['user']);
    const { Token } = await createToken(owner, 'to delete', ['user'], null);

    await deleteToken(Token.Uuid);
    const row = await AccessToken.where('Uuid', Token.Uuid).first();
    expect(row).to.be.undefined;
  });

  it('grants and revokes role on token, only owner-held roles grantable', async () => {
    const { User: owner } = await create('c6@spinajs.com', 'c6', 'password123', ['user', 'admin']);
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
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
  });

  it('refuses to revoke the last role, leaving the row untouched', async () => {
    const { User: owner } = await create('c7@spinajs.com', 'c7', 'password123', ['user']);
    const { Token } = await createToken(owner, 'single role', ['user'], null);

    const err = await revokeTokenRole(Token.Uuid, 'user').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as ErrorCode).code).to.equal(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED);

    // an empty @Set() column stores as '' and reads back as [''] - a phantom
    // role that survives every later grant, so the refusal must be total
    const reloaded = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(reloaded.Roles).to.deep.equal(['user']);
  });
});

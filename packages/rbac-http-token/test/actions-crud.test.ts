import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../src/actions.js';
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
    await expect(createToken(owner, 'bad', ['admin'], null)).to.be.rejected;
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

    await expect(grantTokenRole(Token.Uuid, 'system')).to.be.rejected;
  });
});

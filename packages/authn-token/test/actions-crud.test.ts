import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create } from '@spinajs/users';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, deleteToken } from '../src/legacy/actions.js';
import '../src/generator.js';
import '../src/legacy/role-policy.js';

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

  it('accepts expiration date', async () => {
    const { User: owner } = await create('c2@spinajs.com', 'c2', ['user'], { password: 'password123' });
    const expires = DateTime.now().plus({ days: 7 });

    const { Token } = await createToken(owner, 'temp', ['user'], expires);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.ExpiresAt?.toISODate()).to.equal(expires.toISODate());
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
});

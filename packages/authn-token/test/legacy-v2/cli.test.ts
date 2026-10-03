import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create, activate } from '@spinajs/users';

import { DbTestConfiguration } from '../db-common.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { CreateToken } from '../../src/cli/CreateToken.js';
import '../../src/generator.js';

describe('access token cli commands', function () {
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

  async function makeUser(mail: string, login: string, roles: string[] = ['user']) {
    const { User: u } = await create(mail, login, roles, { password: 'password123' });
    await activate(u.Id);
    return u;
  }

  it('rbac:token-create creates token for user', async () => {
    const user = await makeUser('cli1@spinajs.com', 'cli1');
    const cmd = await DI.resolve(CreateToken);

    await cmd.execute(user.Uuid, { name: 'cli token', roles: 'user', expires: undefined });

    const tokens = await AccessToken.where('user_id', user.Id);
    expect(tokens).to.have.length(1);
    expect(tokens[0].Name).to.equal('cli token');
    expect(tokens[0].ExpiresAt).to.be.null;
  });
});

import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';

import { DbTestConfiguration } from './db-common.js';
import { CreateToken } from '../src/cli/CreateToken.js';

// cli.test.ts resolves the Orm itself; the cli does not, so this one must not.
describe('access token cli commands boot the Orm', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
  });

  after(() => {
    DI.clearCache();
  });

  it('resolving rbac:token-create brings the Orm up', async () => {
    expect(DI.get(Orm), 'nothing resolved the Orm yet').to.be.undefined;

    await DI.resolve(CreateToken);

    expect(DI.get(Orm)).to.not.be.undefined;
  });
});

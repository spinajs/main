import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { CliCommand } from '@spinajs/cli';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import { FakeIdentityStore } from '@spinajs/authn-testing';

import { V3DbConfiguration, shutdownV3Db } from './v3/db.js';
import { CreateToken } from '../src/cli/CreateToken.js';
import { DeleteToken } from '../src/cli/DeleteToken.js';
import { DeleteExpiredTokens } from '../src/cli/DeleteExpiredTokens.js';
import { DbTokenService, TokenOwnerResolver, UsersTableTokenOwnerResolver } from '../src/service/index.js';
import { AccessToken } from '../src/models/AccessToken.js';

/** The commands inject the TokenService, and DbTokenService refuses to build without an IdentityStore. */
class OrmBootIdentityStore extends FakeIdentityStore {}

// v3/cli.test.ts resolves the Orm itself; the cli does not, so this one must not. The connection has
// Migration.OnStartup on: the command's Orm applies the migrations before its first model query.
describe('token cli commands boot the Orm', function () {
  this.timeout(15000);

  const commands: ReadonlyArray<readonly [string, Class<CliCommand>]> = [
    ['authn:token-create', CreateToken],
    ['authn:token-delete', DeleteToken],
    ['authn:token-delete-expired', DeleteExpiredTokens],
  ];

  for (const [name, command] of commands) {
    describe(name, () => {
      before(async () => {
        DI.setESMModuleSupport();
        DI.uncache(OrmMigrator);
        DI.uncache(Orm);
        DI.uncache(Configuration);
        DI.uncache(V3DbConfiguration);
        DI.uncache('orm-driver-sqlite');
        DI.uncache(SqliteOrmDriver);
        DI.uncache(command);

        DI.register(V3DbConfiguration).as(Configuration);
        DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
        DI.register(OrmBootIdentityStore).as(IdentityStore);
        await DI.resolve(Configuration);
      });

      after(async () => {
        DI.unregister(OrmBootIdentityStore);
        DI.uncache(OrmBootIdentityStore);
        DI.uncache(IdentityStore);
        DI.uncache(DbTokenService);
        DI.uncache(TokenService);
        DI.uncache(UsersTableTokenOwnerResolver);
        DI.uncache(TokenOwnerResolver);
        DI.uncache(command);
        await shutdownV3Db();
      });

      it(`resolving ${name} brings the Orm up and runs the boot migrations`, async () => {
        expect(DI.get(Orm), 'nothing resolved the Orm yet').to.be.undefined;

        await DI.resolve(command);

        expect(DI.get(Orm)).to.not.be.undefined;
        expect(await AccessToken.query()).to.deep.eq([]);
      });
    });
  }
});

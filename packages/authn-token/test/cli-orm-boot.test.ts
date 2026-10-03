import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { V3DbConfiguration, shutdownV3Db } from './v3/db.js';
import { CreateToken } from '../src/cli/CreateToken.js';
import { DeleteToken } from '../src/cli/DeleteToken.js';
import { DeleteExpiredTokens } from '../src/cli/DeleteExpiredTokens.js';
import type { TokenCliCommand } from '../src/cli/TokenCliCommand.js';

// v3/cli.test.ts resolves the Orm itself; the cli does not, so this one must not.
describe('token cli commands boot the Orm', function () {
  this.timeout(15000);

  const commands: ReadonlyArray<readonly [string, Class<TokenCliCommand>]> = [
    ['authn:token-create', CreateToken],
    ['authn:token-delete', DeleteToken],
    ['authn:token-delete-expired', DeleteExpiredTokens],
  ];

  for (const [name, command] of commands) {
    describe(name, () => {
      before(async () => {
        DI.setESMModuleSupport();
        DI.uncache(Orm);
        DI.uncache(Configuration);
        DI.uncache(V3DbConfiguration);
        DI.uncache('orm-driver-sqlite');
        DI.uncache(SqliteOrmDriver);
        DI.uncache(command);

        DI.register(V3DbConfiguration).as(Configuration);
        DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
        await DI.resolve(Configuration);
      });

      after(async () => {
        DI.uncache(command);
        await shutdownV3Db();
      });

      it(`resolving ${name} brings the Orm up`, async () => {
        expect(DI.get(Orm), 'nothing resolved the Orm yet').to.be.undefined;

        await DI.resolve(command);

        expect(DI.get(Orm)).to.not.be.undefined;
      });
    });
  }
});

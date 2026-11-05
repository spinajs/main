import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, PendingMigrationsException } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { CliCommand } from '@spinajs/cli';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import { FakeIdentityStore } from '@spinajs/authn-testing';

import { V3DbConfiguration, shutdownV3Db, uncacheOwn } from './v3/db.js';
import { CreateToken } from '../src/cli/CreateToken.js';
import { DeleteToken } from '../src/cli/DeleteToken.js';
import { DeleteExpiredTokens } from '../src/cli/DeleteExpiredTokens.js';
import { DbTokenService, TokenOwnerResolver, UsersTableTokenOwnerResolver } from '../src/service/index.js';
import { AccessToken } from '../src/models/AccessToken.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

/** The commands inject the TokenService, and DbTokenService refuses to build without an IdentityStore. */
class OrmBootIdentityStore extends FakeIdentityStore {}

// v3/cli.test.ts resolves the Orm itself; the cli does not, so this one must not. The database is a file, so the
// migrate-up run and the command's boot are separate Orms on one database, as in a deploy.
describe('token cli commands boot the Orm', function () {
  this.timeout(15000);

  const commands: ReadonlyArray<readonly [string, Class<CliCommand>]> = [
    ['authn:token-create', CreateToken],
    ['authn:token-delete', DeleteToken],
    ['authn:token-delete-expired', DeleteExpiredTokens],
  ];

  for (const [name, command] of commands) {
    describe(name, () => {
      let dir = '';

      before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-token-cli-'));
        V3DbConfiguration.Filename = path.join(dir, 'token-cli.sqlite');

        DI.setESMModuleSupport();
        uncacheOwn();
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
        V3DbConfiguration.Filename = ':memory:';
        fs.rmSync(dir, { recursive: true, force: true });
      });

      // MUST RUN FIRST: the next test migrates the database this one finds unmigrated.
      it(`resolving ${name} refuses an unmigrated database and names migrate-up`, async () => {
        expect(DI.get(Orm), 'nothing resolved the Orm yet').to.be.undefined;

        await expect(DI.resolve(command)).to.be.rejectedWith(PendingMigrationsException, /npx spinajs migrate-up/);

        expect(DI.get(Orm)).to.be.undefined;
      });

      it(`resolving ${name} after migrate-up brings the Orm up over the migrated tables`, async () => {
        const { orm: tool } = await migrateTestDatabase(DI.child());
        await tool.dispose();

        await DI.resolve(command);

        expect(DI.get(Orm)).to.not.be.undefined;
        expect(await AccessToken.query()).to.deep.eq([]);
      });
    });
  }
});

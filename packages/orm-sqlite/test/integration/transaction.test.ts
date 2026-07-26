/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration coverage for the transaction contract against a real, **on-disk** SQLite file.
 *
 *   npm run test:integration --workspace=@spinajs/orm-sqlite
 *
 * On-disk rather than `:memory:` on purpose — an in-memory database is torn down with the
 * process, so a "rollback" that silently did nothing would still look like a pass.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import '@spinajs/log';

import { SqliteOrmDriver } from '../../src/index.js';
import { IntegrationUser } from './models/IntegrationUser.js';
import './migrations/IntegrationTransactionMigration_2026_07_25_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

let dbDir: string;
let dbFile: string;

export class IntegrationConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        db: {
          Migration: { Startup: false },
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Name: 'sqlite',
              Filename: dbFile,
              Migration: { Table: 'orm_migrations_integration', OnStartup: false },
            },
          ],
        },
      },
      (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

function db() {
  return DI.get(Orm)!;
}

function driver() {
  return db().Connections.get('sqlite')!;
}

describe('SQLite transaction contract (integration)', function () {
  this.timeout(30000);

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'spinajs-orm-sqlite-'));
    dbFile = join(dbDir, 'integration.sqlite');

    DI.clearCache();
    DI.register(IntegrationConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
    await db().migrateUp();
    // model descriptors get their columns from the live schema; without this the
    // insert compiler has no columns to work with
    await db().reloadTableInfo();

    expect(existsSync(dbFile), 'the database must really be on disk').to.be.true;
  });

  beforeEach(async () => {
    await driver().truncate('integration_user');
  });

  after(async () => {
    await driver().disconnect();
    DI.clearCache();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('commits on success', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'a' });
    });

    expect(await IntegrationUser.count()).to.equal(1);
  });

  it('returns the callback result', async () => {
    const result = await driver().transaction(async () => 'the-value');
    expect(result).to.equal('the-value');
  });

  it('rolls back on throw', async () => {
    await expect(
      driver().transaction(async () => {
        await IntegrationUser.create({ Name: 'a' });
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(await IntegrationUser.count()).to.equal(0);
  });

  it('inner savepoint rolls back without discarding the outer transaction', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'outer' });

      await driver()
        .transaction(async () => {
          await IntegrationUser.create({ Name: 'inner' });
          throw new Error('inner fails');
        })
        .catch(() => undefined);
    });

    const rows = await IntegrationUser.all();
    expect(rows.map((r) => r.Name)).to.deep.equal(['outer']);
  });

  it('a nested transaction that succeeds folds into the outer commit', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'outer' });
      await driver().transaction(async () => {
        await IntegrationUser.create({ Name: 'inner' });
      });
    });

    const rows = await IntegrationUser.all();
    expect(rows.map((r) => r.Name).sort()).to.deep.equal(['inner', 'outer']);
  });

  it('does not leave a transaction open after many sequential transactions', async () => {
    for (let i = 0; i < 50; i++) {
      await driver().transaction(async () => {
        await IntegrationUser.count();
      });
    }

    // a leaked BEGIN would make this fail with "cannot start a transaction within a transaction"
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'still-works' });
    });

    expect(await IntegrationUser.count()).to.equal(1);
  });

  it('accepts SERIALIZABLE and rejects every other isolation level', async () => {
    await driver().transaction(async () => IntegrationUser.count(), { isolation: 'SERIALIZABLE' });

    await expect(driver().transaction(async () => 1, { isolation: 'READ UNCOMMITTED' })).to.be.rejected;
  });
});

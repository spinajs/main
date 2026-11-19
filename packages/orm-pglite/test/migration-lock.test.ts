import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Migration, MigrationLock, OrmMigration, TableMigrationLock } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import * as chai from 'chai';
import 'mocha';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;

class PgliteLockConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite-lock', Filename: ':memory:' }] },
    });
  }
}

@Migration('pglite-lock')
class PgliteLockTable_2026_11_19_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('pgl_lock_item', (t) => {
      t.int('Id').primaryKey();
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }
}

describe('PGlite migration lock', function () {
  this.timeout(60000);

  before(async () => {
    DI.register(PgliteLockConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    await DI.resolve(Configuration);
  });

  after(async () => {
    DI.unregister(PgliteLockTable_2026_11_19_00_00_00);
    await DI.dispose();
    DI.clearCache();
  });

  it('migrates under the lock-table row: PGlite has one session, so no session lock can be held beside it', async () => {
    const { orm, executed } = await migrateTestDatabase();
    const driver = orm.Connections.get('pglite-lock')!;

    expect(executed.map((m) => m.constructor.name)).to.deep.equal(['PgliteLockTable_2026_11_19_00_00_00']);
    expect(await driver.Container.resolve(MigrationLock, [driver])).to.be.instanceOf(TableMigrationLock);
    expect(await driver.tableInfo('pgl_lock_item')).to.not.equal(null);
  });
});

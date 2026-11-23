import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Migration, MIGRATION_TABLE_NAME, Orm, OrmDriver, OrmMigration, OrmMigrationGuard, PendingMigrationsException, resolveMigrationTool } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const MAIN = 'sqlite-guard';
const IDLE = 'sqlite-guard-idle';
const FIRST = 'GuardFirst_2026_10_01_00_00_00';
const SECOND = 'GuardSecond_2026_10_02_00_00_00';

class GuardSqliteConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: MAIN },
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: IDLE },
          ],
        },
      },
      mergeArrays,
    );
  }
}

function defineMigrations() {
  @Migration(MAIN)
  class GuardFirst_2026_10_01_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('guard_first', (table) => {
        table.int('Id').primaryKey();
      });
    }

    public async down(): Promise<void> {}
  }

  @Migration(MAIN)
  class GuardSecond_2026_10_02_00_00_00 extends OrmMigration {
    public async up(): Promise<void> {}
    public async down(): Promise<void> {}
  }

  return [GuardFirst_2026_10_01_00_00_00, GuardSecond_2026_10_02_00_00_00];
}

describe('OrmMigrationGuard on a real sqlite tracking table', function () {
  this.timeout(20000);

  let types: ReturnType<typeof defineMigrations>;
  let connects: sinon.SinonSpy;

  before(() => {
    types = defineMigrations();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    types.forEach((t) => DI.unregister(t));
    DI.unregister(GuardSqliteConf);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    DI.register(GuardSqliteConf).as(Configuration);
    connects = sinon.spy(SqliteOrmDriver.prototype, 'connect');
  });

  afterEach(async () => {
    for (const driver of connects.thisValues as SqliteOrmDriver[]) {
      driver.stopHealthCheck();
      await driver.disconnect();
    }

    sinon.restore();
    DI.clearCache();
  });

  it('reports everything pending before the first migrate, then passes after it, creating nothing itself', async () => {
    const migrator = await resolveMigrationTool();
    const orm = await DI.resolve(Orm);
    const guard = await DI.resolve(OrmMigrationGuard);

    const err = (await guard.check(orm).catch((e: unknown) => e)) as PendingMigrationsException;

    expect(err).to.be.instanceOf(PendingMigrationsException);
    expect(err.pending).to.deep.equal([
      { name: FIRST, connection: MAIN },
      { name: SECOND, connection: MAIN },
    ]);
    expect(await orm.Connections.get(MAIN)!.schema().tableExists(MIGRATION_TABLE_NAME), 'the guard must not create the tracking table').to.be.false;
    expect(await orm.Connections.get(IDLE)!.schema().tableExists(MIGRATION_TABLE_NAME)).to.be.false;

    await migrator.migrate();

    expect(await guard.check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
  });

  // a NULL FinishedAt must hydrate as null, not undefined, or the legacy-row rule reads a never finished row as applied
  it('reports a FAILED row as failed and a never finished one as pending', async () => {
    const migrator = await resolveMigrationTool();
    const orm = await DI.resolve(Orm);
    const guard = await DI.resolve(OrmMigrationGuard);

    await migrator.migrate();
    await orm.Connections.get(MAIN)!.update().in(MIGRATION_TABLE_NAME).update({ FinishedAt: null }).where('Migration', FIRST);
    await orm.Connections.get(MAIN)!.update().in(MIGRATION_TABLE_NAME).update({ FinishedAt: null, Logs: 'boom' }).where('Migration', SECOND);

    const err = (await guard.check(orm).catch((e: unknown) => e)) as PendingMigrationsException;

    expect(err).to.be.instanceOf(PendingMigrationsException);
    expect(err.failed).to.deep.equal([{ name: SECOND, connection: MAIN }]);
    expect(err.pending).to.deep.equal([{ name: FIRST, connection: MAIN }]);
  });
});

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { MigrationTransactionMode, Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import '@spinajs/orm-mysql';
// registers the log targets ( incl. BlackHoleTarget ) referenced by the logger config below;
// importing the migration files directly ( rather than the queue barrel ) does not pull it in
import '@spinajs/log';

// The queue migrations are the subject under test. Importing the migration modules directly
// registers them via the @Migration('queue') decorator ( same effect as importing the package
// barrel ) without pulling in the JobModel schema auto-load, which would race the migrations
// on a still-empty database. These are the exact files the branch touched ( esp. 07_02 / 07_17
// restating the Status default across MySQL's destructive MODIFY COLUMN ).
import '../src/migrations/Queue_2022_10_18_01_13_00.js';
import '../src/migrations/Queue_2026_06_30_00_00_00.js';
import '../src/migrations/Queue_2026_07_02_00_00_00.js';
import '../src/migrations/Queue_2026_07_10_00_00_00.js';
import '../src/migrations/Queue_2026_07_17_00_00_00.js';

chai.use(chaiAsPromised);

/**
 * Env gate. This suite needs a real MySQL ( the dialect-specific MODIFY / ENUM branches never
 * execute on sqlite ). When SPINAJS_TEST_MYSQL_HOST is unset the whole suite self-skips so
 * local / sqlite-only runs stay green with a visible "pending" marker instead of a failure.
 * The CI workflow ( .github/workflows/migrations-mysql.yml ) sets these against a mysql:8.0
 * service container.
 */
const HOST = process.env.SPINAJS_TEST_MYSQL_HOST;
const PORT = process.env.SPINAJS_TEST_MYSQL_PORT ? parseInt(process.env.SPINAJS_TEST_MYSQL_PORT, 10) : 3306;
const USER = process.env.SPINAJS_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.SPINAJS_TEST_MYSQL_PASSWORD ?? '';
const DB = process.env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_queue_test';

const MIGRATION_TABLE = 'orm_migrations';

/**
 * Raw SQL escape hatch. `executeOnDb` lives on orm-sql's SqlDriver ( the MySQL driver's base ),
 * not on the base OrmDriver contract, so it is surfaced here without taking a direct dependency
 * on @spinajs/orm-sql. Used only for information_schema / migration-table introspection.
 */
interface IRawSqlDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<any>;
}

function raw(cn: OrmDriver): IRawSqlDriver {
  return cn as unknown as IRawSqlDriver;
}

const EXPECTED_MIGRATIONS = ['Queue_2022_10_18_01_13_00', 'Queue_2026_06_30_00_00_00', 'Queue_2026_07_02_00_00_00', 'Queue_2026_07_10_00_00_00', 'Queue_2026_07_17_00_00_00'];

class MysqlQueueConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      db: {
        DefaultConnection: 'queue',
        Connections: [
          {
            Driver: 'orm-driver-mysql',
            Name: 'queue',
            Host: HOST,
            Port: PORT,
            User: USER,
            Password: PASSWORD,
            Database: DB,
            // OnStartup: false so resolving Orm does NOT auto-migrate - the suite drops any
            // leftover tables from a dirty previous run first, then drives migrateUp() itself.
            Migration: {
              OnStartup: false,
              Table: MIGRATION_TABLE,
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

async function dropQueueTables(cn: OrmDriver) {
  // order does not matter ( no FKs ); ifExists keeps this idempotent across dirty runs
  await cn.schema().dropTable('queue_jobs').ifExists();
  await cn.schema().dropTable(MIGRATION_TABLE).ifExists();
}

interface IColumnRow {
  COLUMN_NAME: string;
  COLUMN_DEFAULT: string | null;
  IS_NULLABLE: string;
}

async function columnInfo(cn: OrmDriver): Promise<IColumnRow[]> {
  return (await raw(cn).executeOnDb(`SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'queue_jobs'`, [DB], QueryContext.Select)) as IColumnRow[];
}

// SPINAJS_TEST_MYSQL_HOST unset -> whole suite is pending, never failing.
const suite = HOST ? describe : describe.skip;

suite('queue migrations against MySQL (dialect regression: Status default across MODIFY COLUMN)', function () {
  this.timeout(60000);

  let orm: Orm;
  let cn: OrmDriver;

  before(async () => {
    DI.clearCache();
    DI.register(MysqlQueueConf).as(Configuration);

    await DI.resolve(Configuration);
    orm = await DI.resolve(Orm);
    cn = orm.Connections.get('queue') as OrmDriver;

    // start from a clean slate even if a previous run crashed mid-migration
    await dropQueueTables(cn);

    // the actual exercise: every queue migration ( incl. the MySQL-only MODIFY / ENUM branches )
    // must apply without a dialect error. This line alone catches the enum / MODIFY regressions.
    await orm.migrateUp();
  });

  after(async () => {
    if (cn) {
      await dropQueueTables(cn);
      await cn.disconnect();
    }
    DI.clearCache();
  });

  it('records every queue migration as applied', async () => {
    const rows = (await raw(cn).executeOnDb(`SELECT Migration FROM ${MIGRATION_TABLE}`, [], QueryContext.Select)) as Array<{ Migration: string }>;
    const applied = rows.map((r) => r.Migration);
    expect(applied).to.include.members(EXPECTED_MIGRATIONS);
  });

  it('queue_jobs has the expected columns', async () => {
    const names = (await columnInfo(cn)).map((c) => c.COLUMN_NAME);
    expect(names).to.include.members(['Status', 'Attempt', 'MaxAttempts', 'LastError', 'Phase', 'Message', 'UpdatedAt', 'FinishedAt']);
  });

  it('Status keeps its NOT NULL "created" default after MySQL MODIFY COLUMN', async () => {
    const status = (await columnInfo(cn)).find((c) => c.COLUMN_NAME === 'Status');
    expect(status, 'Status column exists').to.not.be.undefined;
    // the regression the branch fixed: MySQL MODIFY COLUMN dropping the omitted default
    expect(status!.COLUMN_DEFAULT).to.equal('created');
    expect(status!.IS_NULLABLE).to.equal('NO');
  });

  it('an insert that omits Status reads back Status = created (strict-mode safe)', async () => {
    const jobId = '00000000-0000-4000-8000-000000000001';

    // raw insert providing only the NOT-NULL columns without a default ( JobId / Name / Connection );
    // Status must fall back to its column default rather than erroring under strict mode
    await cn.insert().into('queue_jobs').values({
      JobId: jobId,
      Name: 'DefaultProbeJob',
      Connection: 'queue',
    });

    const row = (await cn.select().from('queue_jobs').where({ JobId: jobId }).first()) as { Status: string };
    expect(row).to.not.be.undefined;
    expect(row.Status).to.equal('created');
  });
});

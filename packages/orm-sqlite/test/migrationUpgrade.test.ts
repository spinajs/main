/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MIGRATION_TABLE_NAME, Migration, Orm, OrmDriver, OrmMigration, OrmMigrator, PendingMigrationsException, QueryContext, resolveMigrationTool } from '@spinajs/orm';
import * as chai from 'chai';
import { existsSync, unlinkSync } from 'fs';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';
// SqliteOrmDriver is only a type here, and that import is elided: the driver registers on load
import './../src/index.js';
import { SqliteOrmDriver } from './../src/index.js';
import { dir, mergeArrays } from './util.js';

const expect = chai.expect;

/**
 * The only test in this package that runs the tracking-table UPGRADE path against a real
 * database rather than a fake driver.
 *
 * The scenario is an existing deployment: a `spinajs_migration` table in the shape the ORM
 * used to create - `Migration` + `CreatedAt` and nothing else - already carrying a row for a
 * migration that ran years ago. An application's boot reads that row as APPLIED without changing
 * the table; `migrate-up` then has to add the six columns the new service needs, backfill them
 * from `CreatedAt`, and still read the old row as APPLIED so its migration is not executed a
 * second time over a schema that already has it.
 *
 * `:memory:` cannot express this: every sqlite handle gets its own private database, so the
 * table crafted before boot would be invisible to the connection the Orm opens. Hence the
 * temp file, and hence the cleanup.
 */

const CONNECTION_NAME = 'sqlite-upgrade';
const DB_FILE = dir('./migration-upgrade.sqlite');
const LOCK_TABLE_NAME = `${MIGRATION_TABLE_NAME}_lock`;

/** Columns the upgrade has to add to a legacy table. */
const NEW_COLUMNS = ['StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'];

/** Columns a legacy table already has, and which the upgrade must not disturb. */
const LEGACY_COLUMNS = ['Migration', 'CreatedAt'];

/**
 * The migration the legacy table already has a row for. Its `up()` must NOT run again - that
 * is what "the old row still reads as applied" means in practice.
 */
const LEGACY_MIGRATION = 'UpgradeLegacy_2020_01_01_00_00_00';
const LEGACY_CREATED_AT = '2020-01-01 00:00:00';

/** A migration the legacy table knows nothing about. It MUST run - see `freshUpRuns` below. */
const FRESH_MIGRATION = 'UpgradeFresh_2021_01_01_00_00_00';

const LEGACY_MARKER_TABLE = 'upgrade_legacy_marker';
const FRESH_MARKER_TABLE = 'upgrade_fresh_marker';

class UpgradeConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },

        db: {
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: DB_FILE,
              Name: CONNECTION_NAME,

              // one handle, so nothing is left holding the file when it is deleted below
              Pool: { Max: 1 },

              // deliberately no `Migration.Table`: this exercises the default MIGRATION_TABLE_NAME
              // path, which is the name a real legacy deployment would be carrying
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}

/**
 * `bestEffort` is for teardown only. A boot that threw halfway leaves a connected driver nobody
 * has a handle to, and windows refuses to unlink a file sqlite still holds open - so a strict
 * teardown turns one real failure into two, the second of which says nothing about the code under
 * test. Setup stays strict: there the file is left over from a previous PROCESS, nothing in this
 * one holds it, and a failure to remove it means the fixture is not what the test assumes.
 */
function removeDbFiles(bestEffort = false) {
  // a journal leaves -wal / -shm siblings behind; removing only the main file leaves stale state
  [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].forEach((f) => {
    if (!existsSync(f)) {
      return;
    }

    try {
      unlinkSync(f);
    } catch (err) {
      if (!bestEffort) {
        throw err;
      }
    }
  });
}

describe('Sqlite migration tracking table upgrade', function () {
  this.timeout(20000);

  let orm: Orm;
  let migrator: OrmMigrator;

  /** PRAGMA-read column names of the tracking table as it was BEFORE the Orm booted. */
  let preBootColumns: string[] = [];

  /** Whether the lock table existed before the Orm booted. */
  let preBootLockTableExists = true;

  /** What an application's boot on the legacy table threw, and the table as that boot left it. */
  let appBootError: unknown;
  let afterAppBootColumns: string[] = [];
  let afterAppBootLockTableExists = true;

  let legacyMigrationType: any;
  let freshMigrationType: any;

  let legacyUpRuns = 0;
  let freshUpRuns = 0;

  /**
   * Declared here rather than at module scope on purpose. `@Migration` registers into the
   * global DI container the moment the class is evaluated, and mocha runs every file in one
   * process - so a module-scope declaration would be handed to every other suite's Orm too.
   * Declaring them here pairs the registration with the `DI.unregister` in `after()`.
   */
  function defineMigrations() {
    @Migration(CONNECTION_NAME)
    class UpgradeLegacy_2020_01_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        legacyUpRuns++;

        await connection.schema().createTable(LEGACY_MARKER_TABLE, (t) => {
          t.int('Id').primaryKey().autoIncrement();
        });
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    @Migration(CONNECTION_NAME)
    class UpgradeFresh_2021_01_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        freshUpRuns++;

        await connection.schema().createTable(FRESH_MARKER_TABLE, (t) => {
          t.int('Id').primaryKey().autoIncrement();
        });
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    legacyMigrationType = UpgradeLegacy_2020_01_01_00_00_00;
    freshMigrationType = UpgradeFresh_2021_01_01_00_00_00;
  }

  /**
   * Writes the legacy table with raw SQL on a throwaway handle, before anything from the
   * migration service has touched the file. Raw on purpose: the point is a table this codebase
   * did not create, so going through the current schema builder would be assuming the answer.
   */
  async function onRawHandle<T>(fn: (driver: SqliteOrmDriver) => Promise<T>): Promise<T> {
    const driver = await DI.resolve<SqliteOrmDriver>('orm-driver-sqlite', [{ Driver: 'orm-driver-sqlite', Name: 'legacy-prep', Filename: DB_FILE, Pool: { Max: 1 } }]);

    await driver.connect();

    try {
      return await fn(driver);
    } finally {
      await driver.disconnect();
    }
  }

  /**
   * PRAGMA rather than driver.tableInfo(): tableInfo() reads the value-converter map that only an
   * Orm boot registers, and these snapshots are taken outside any Orm.
   */
  async function snapshot(): Promise<{ columns: string[]; lockTableExists: boolean }> {
    return await onRawHandle(async (driver) => {
      const columns = ((await driver.executeOnDb(`PRAGMA table_info(${MIGRATION_TABLE_NAME});`, [] as any, QueryContext.Select)) as any[]).map((c) => c.name as string);
      const lockRows = (await driver.executeOnDb(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [LOCK_TABLE_NAME] as any, QueryContext.Select)) as any[];
      return { columns, lockTableExists: lockRows.length > 0 };
    });
  }

  async function craftLegacyDatabase() {
    await onRawHandle(async (driver) => {
      await driver.executeOnDb(`CREATE TABLE \`${MIGRATION_TABLE_NAME}\` (\`Migration\` TEXT NOT NULL UNIQUE, \`CreatedAt\` TEXT NOT NULL)`, [] as any, QueryContext.Schema);
      await driver.executeOnDb(`INSERT INTO \`${MIGRATION_TABLE_NAME}\` (\`Migration\`, \`CreatedAt\`) VALUES (?, ?)`, [LEGACY_MIGRATION, LEGACY_CREATED_AT] as any, QueryContext.Insert);
    });

    ({ columns: preBootColumns, lockTableExists: preBootLockTableExists } = await snapshot());
  }

  before(async () => {
    DI.clearCache();
    removeDbFiles();

    // No `DI.register(SqliteOrmDriver).as('orm-driver-sqlite')` here: the class carries
    // `@Injectable('orm-driver-sqlite')` and importing it registers it. An explicit re-register
    // was inert but unpaired - nothing in `after()` could take it back, because unregistering
    // the type would also drop the decorator's registration and break every later suite.
    await craftLegacyDatabase();

    defineMigrations();

    DI.register(UpgradeConnectionConf).as(Configuration);

    // a deploy that boots the application before migrate-up: its own container, as its own process
    appBootError = await DI.child()
      .resolve(Orm)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    ({ columns: afterAppBootColumns, lockTableExists: afterAppBootLockTableExists } = await snapshot());

    // the subject of the rest of the suite: migrate-up, and nothing else
    migrator = await resolveMigrationTool();
    orm = migrator.Orm;
    await migrator.migrate();
  });

  after(async () => {
    // `finally`, because a dispose() that throws must not skip the cleanup below. `@Migration`
    // and the configuration are registered in the GLOBAL container and mocha runs every file in
    // one process, so leaking them makes every later suite boot this suite's migrations against
    // this suite's config - a failure that surfaces in an unrelated file.
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(UpgradeConnectionConf);

      // guarded: a `before` that died before defineMigrations() leaves these undefined, and an
      // unregister that throws in `after` would bury whatever actually failed
      [legacyMigrationType, freshMigrationType].filter(Boolean).forEach((t) => DI.unregister(t));

      DI.clearCache();

      removeDbFiles(true);
    }
  });

  function connection(): OrmDriver {
    return orm.Connections.get(CONNECTION_NAME)!;
  }

  async function trackingRows(): Promise<any[]> {
    return (await connection().select().from(MIGRATION_TABLE_NAME).asRaw<any[]>()) as any[];
  }

  it('starts from a table that really is legacy', () => {
    // guards every assertion below: if the fixture ever grew the new columns by itself, the
    // upgrade assertions would pass without an upgrade ever having happened
    expect(preBootColumns).to.have.members(LEGACY_COLUMNS);

    NEW_COLUMNS.forEach((c) => {
      expect(preBootColumns, `column ${c} was present before boot - the fixture is not legacy`).to.not.include(c);
    });

    expect(preBootLockTableExists, 'lock table existed before boot').to.be.false;
  });

  it("an application's boot reads the legacy row as applied, names only the unrecorded migration and changes nothing", () => {
    expect(appBootError).to.be.instanceOf(PendingMigrationsException);
    expect((appBootError as PendingMigrationsException).pending).to.deep.equal([{ name: FRESH_MIGRATION, connection: CONNECTION_NAME }]);
    expect((appBootError as PendingMigrationsException).failed).to.deep.equal([]);

    expect(afterAppBootColumns, 'the boot check upgraded the tracking table').to.have.members(LEGACY_COLUMNS);
    expect(afterAppBootLockTableExists, 'the boot check created the lock table').to.be.false;
  });

  it('adds every new tracking column on migrate-up and keeps the legacy ones', async () => {
    const cols = await connection().tableInfo(MIGRATION_TABLE_NAME, connection().Options.Database);

    expect(cols, 'tracking table is gone after migrate-up').to.be.not.null;

    const names = cols.map((c) => c.Name);

    NEW_COLUMNS.forEach((c) => {
      expect(names, `missing column ${c}`).to.include(c);
    });

    LEGACY_COLUMNS.forEach((c) => {
      expect(names, `legacy column ${c} was dropped`).to.include(c);
    });
  });

  it('backfills the legacy row from CreatedAt instead of leaving it half-filled', async () => {
    const row = (await trackingRows()).find((r) => r.Migration === LEGACY_MIGRATION);

    expect(row, `row ${LEGACY_MIGRATION} disappeared`).to.be.not.undefined;

    // the row predates StartedAt/FinishedAt entirely, so CreatedAt is the only timestamp
    // there is to treat as both
    expect(row.CreatedAt).to.eq(LEGACY_CREATED_AT);
    expect(row.StartedAt).to.eq(LEGACY_CREATED_AT);
    expect(row.FinishedAt).to.eq(LEGACY_CREATED_AT);

    expect(row.RolledBackAt).to.be.null;
    expect(row.Logs).to.be.null;

    // nothing fingerprinted a migration that ran before checksums existed - a NULL here is
    // correct, an invented hash would not be
    expect(row.Checksum).to.be.null;

    expect(row.Batch).to.eq(1);
  });

  it('reads the backfilled legacy row as applied and does not run its migration again', async () => {
    // the decisive assertion of this suite: a legacy row whose FinishedAt failed to backfill
    // would look pending, and up() would re-run a migration over a schema that already has it
    expect(legacyUpRuns, `${LEGACY_MIGRATION} ran again over an already-migrated schema`).to.eq(0);

    const exists = await connection().schema().tableExists(LEGACY_MARKER_TABLE);
    expect(exists, `${LEGACY_MARKER_TABLE} exists, so ${LEGACY_MIGRATION}.up() executed`).to.be.false;
  });

  it('still runs the migration the legacy table never recorded', async () => {
    // without this the test above would also pass on a run that ran nothing at all
    expect(freshUpRuns).to.eq(1);

    const exists = await connection().schema().tableExists(FRESH_MARKER_TABLE);
    expect(exists).to.be.true;

    const row = (await trackingRows()).find((r) => r.Migration === FRESH_MIGRATION);

    expect(row, `${FRESH_MIGRATION} was not recorded`).to.be.not.undefined;
    expect(row.FinishedAt).to.be.not.null;
    expect(row.Checksum).to.be.a('string');

    // one past the highest applied batch. It is 2 rather than 1 only because the backfilled
    // legacy row was READ as batch 1 - a backfill that left Batch NULL would put this at 1
    expect(row.Batch).to.eq(2);
  });

  it('creates the lock table next to the upgraded tracking table', async () => {
    // the upgrade branch is reached only when the tracking table already exists, so the lock
    // table has to be created outside it - easy to lose in an `else`
    const exists = await connection().schema().tableExists(LOCK_TABLE_NAME);
    expect(exists).to.be.true;
  });

  it('reports the legacy migration as applied through status()', async () => {
    const status = await migrator.Runner.status();

    const legacy = status.find((s) => s.name === LEGACY_MIGRATION);
    const fresh = status.find((s) => s.name === FRESH_MIGRATION);

    expect(legacy, `${LEGACY_MIGRATION} missing from status()`).to.be.not.undefined;
    expect(legacy!.applied).to.be.true;
    expect(legacy!.pending).to.be.false;
    expect(legacy!.failed).to.be.false;
    expect(legacy!.rolledBack).to.be.false;
    expect(legacy!.batch).to.eq(1);

    expect(fresh, `${FRESH_MIGRATION} missing from status()`).to.be.not.undefined;
    expect(fresh!.applied).to.be.true;
    expect(fresh!.batch).to.eq(2);
  });

  // MUST RUN LAST - order-terminal. It disposes `orm`, clears the container cache and reassigns
  // `orm` to a second boot, so every test above it observes the FIRST boot and would see this
  // one's state instead if mocha reached it earlier. Add new cases above this, never below.
  it('leaves the upgraded table alone on a second migrate-up, and the application boots on it', async () => {
    // ensureStorage() runs on every run, and the alter branch is guarded by a column probe -
    // a probe that missed would re-add columns and fail on the second run. Every run against an
    // ALREADY EXISTING tracking table takes that path, and only a second run can reach it.
    //
    // This is the run that used to crash: `DI.clearCache()` empties the value-converter map, and
    // `SqliteOrmDriver.tableInfo` reads it from `ensureStorage()`. `Orm.resolve()` registers
    // the converters before anything reads a tracking table, so the map is there by the time this runs.
    await orm.dispose();
    DI.clearCache();

    migrator = await resolveMigrationTool();
    orm = migrator.Orm;
    expect(await migrator.migrate()).to.deep.equal([]);

    const rows = await trackingRows();
    const legacy = rows.find((r) => r.Migration === LEGACY_MIGRATION);

    expect(rows.length).to.eq(2);
    expect(legacy, `row ${LEGACY_MIGRATION} did not survive the second run`).to.be.not.undefined;
    expect(legacy.FinishedAt).to.eq(LEGACY_CREATED_AT);
    expect(legacyUpRuns).to.eq(0);
    expect(freshUpRuns).to.eq(1);

    // a fresh process: the boot check passes on the upgraded table
    await orm.dispose();
    DI.clearCache();
    orm = await DI.resolve(Orm);
    expect(orm.Connections.get(CONNECTION_NAME)).to.not.equal(undefined);
  });
});

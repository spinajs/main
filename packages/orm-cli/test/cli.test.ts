/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MIGRATION_FILE_REGEXP, Migration, Orm, OrmDriver, OrmMigration } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { MigrateCreateCommand, MigrateDownCommand, MigrateResolveCommand, MigrateStatusCommand, MigrateUpCommand } from '../src/index.js';

const expect = chai.expect;

/**
 * One sqlite connection, named and with its own tracking table, plus a logger wired to nothing.
 *
 * `OnStartup: false` is the load-bearing part: the Orm's boot pass runs with `force: false` and
 * honours that gate, so the migrations below are still PENDING when the first command runs. With
 * it on, every assertion here would be made against a database the Orm had already migrated by
 * itself, and the commands would be tested against nothing.
 */
function connectionConf(name: string, table: string): Class<FrameworkConfiguration> {
  return class extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      // Targets are APPENDED and rules REPLACED: appending a rule would leave the packaged
      // console rule matching as well, and every framework log line would land in the mocha
      // reporter on top of the `console.log` output these tests actually assert on.
      const logger = (this.Config.logger ?? {}) as Record<string, unknown>;
      logger.targets = [...((logger.targets as unknown[]) ?? []), { name: 'Empty', type: 'BlackHoleTarget' }];
      logger.rules = [{ name: '*', level: 'trace', target: 'Empty' }];
      this.Config.logger = logger;

      const db = (this.Config.db ?? {}) as Record<string, unknown>;
      db.Connections = [
        ...((db.Connections as unknown[]) ?? []),
        {
          Driver: 'orm-driver-sqlite',
          Filename: ':memory:',
          Name: name,
          Migration: { Table: table, OnStartup: false },
        },
      ];
      this.Config.db = db;
    }
  };
}

/**
 * `console.log` is `migrate-status`'s output, so it is captured rather than silenced: the tests
 * assert on it, and letting it through would bury the mocha reporter in migration tables.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  // eslint-disable-next-line no-console
  const original = console.log;

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };

  try {
    await fn();
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }

  return lines;
}

/** Runs `fn` and hands back whatever it threw, or `undefined` when it did not throw. */
async function thrownBy(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('orm-cli migration commands against sqlite', function () {
  this.timeout(20000);

  const CONNECTION_NAME = 'orm-cli-sqlite';

  /** Not the default `spinajs_migration`: a test that asserts on rows should name its own table. */
  const TRACKING_TABLE = 'orm_cli_migrations';

  /** Created by the test migration's `up()`. Its existence is the proof that `up()` really ran. */
  const MARKER_TABLE = 'orm_cli_marker';

  const TEST_MIGRATION = 'OrmCliTest_2021_01_01_00_00_00';

  /**
   * Declared on a connection this configuration deliberately does NOT define. `up()` on it
   * returns `[]` after a warn rather than throwing - the exact shape that must not be reported
   * as success.
   */
  const ORPHAN_MIGRATION = 'OrmCliOrphan_2021_01_02_00_00_00';
  const ORPHAN_CONNECTION = 'orm-cli-not-configured';

  const Conf = connectionConf(CONNECTION_NAME, TRACKING_TABLE);

  let orm: Orm;
  let testMigrationType: any;
  let orphanMigrationType: any;

  /**
   * Mocha runs every file in one process and `@Migration` registers into the GLOBAL container the
   * moment the class is evaluated, so these are declared inside a function paired with the
   * `DI.unregister` in `after()` rather than at module scope.
   */
  function defineMigrations() {
    @Migration(CONNECTION_NAME)
    class OrmCliTest_2021_01_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        await connection.schema().createTable(MARKER_TABLE, (table) => {
          table.int('Id').primaryKey().autoIncrement();
        });
      }

      public async down(connection: OrmDriver): Promise<void> {
        await connection.schema().dropTable(MARKER_TABLE);
      }
    }

    @Migration(ORPHAN_CONNECTION)
    class OrmCliOrphan_2021_01_02_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    testMigrationType = OrmCliTest_2021_01_01_00_00_00;
    orphanMigrationType = OrmCliOrphan_2021_01_02_00_00_00;
  }

  /**
   * Every command in this package can set `process.exitCode`, and a leaked 1 would fail the whole
   * mocha run long after the assertion that caused it had passed.
   */
  const originalExitCode = process.exitCode;

  before(async () => {
    DI.clearCache();

    defineMigrations();

    DI.register(Conf).as(Configuration);

    orm = await DI.resolve(Orm);
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(Conf);
      [testMigrationType, orphanMigrationType].filter(Boolean).forEach((t) => DI.unregister(t));
      DI.clearCache();

      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  function connection(): OrmDriver {
    return orm.Connections.get(CONNECTION_NAME)!;
  }

  async function trackingRows(): Promise<any[]> {
    return (await connection().select().from(TRACKING_TABLE).asRaw<any[]>()) as any[];
  }

  async function markerTableExists(): Promise<boolean> {
    const rows = (await connection().select().from('sqlite_master').where('name', MARKER_TABLE).asRaw<any[]>()) as any[];
    return rows.length > 0;
  }

  it('migrate-status reports a not-yet-run migration as pending and exits 1', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    const line = out.find((l) => l.includes(TEST_MIGRATION));

    expect(line, `no status line for ${TEST_MIGRATION} in:\n${out.join('\n')}`).to.be.a('string');
    expect(line).to.contain('pending');
    expect(line).to.contain(CONNECTION_NAME);

    // the deploy gate: an un-run migration means "this database is not current"
    expect(process.exitCode).to.equal(1);

    // the migration on the unconfigured connection is skipped by the planner, so it must not
    // appear in a report that claims to list every configured connection
    expect(out.join('\n')).to.not.contain(ORPHAN_MIGRATION);
  });

  it('migrate-up applies the migration and records it in the tracking table', async () => {
    expect(await markerTableExists(), 'marker table existed before migrate-up ran').to.equal(false);

    const cmd = await DI.resolve(MigrateUpCommand);
    await cmd.execute({});

    expect(await markerTableExists(), 'up() did not actually run').to.equal(true);

    const rows = await trackingRows();
    const row = rows.find((r) => r.Migration === TEST_MIGRATION);

    expect(row, `no tracking row for ${TEST_MIGRATION}, got: ${JSON.stringify(rows)}`).to.not.equal(undefined);
    expect(row.FinishedAt, 'tracking row was left unfinished').to.not.equal(null);
    expect(row.RolledBackAt).to.equal(null);

    // a successful run must not leave a non-zero exit code behind
    expect(process.exitCode).to.equal(0);
  });

  it('migrate-status is clean once everything is applied and leaves the exit code at 0', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    const line = out.find((l) => l.includes(TEST_MIGRATION));

    expect(line).to.contain('applied');
    expect(line).to.not.contain('FAILED');
    expect(process.exitCode).to.equal(0);
  });

  it("migrate-up --name does not report success when the migration's connection is not configured", async () => {
    const cmd = await DI.resolve(MigrateUpCommand);

    // `up()` returns [] after a warn here rather than throwing - nothing ran, and the command
    // has to say so instead of printing "0 migrations applied" and exiting clean
    await cmd.execute({ name: ORPHAN_MIGRATION });

    expect(process.exitCode).to.equal(1);
  });

  it('migrate-up --name refuses a name nothing is registered under', async () => {
    const cmd = await DI.resolve(MigrateUpCommand);

    const err = await thrownBy(() => cmd.execute({ name: 'NoSuchThing_2021_01_01_00_00_00' }));

    expect(err, 'a typo was reported as an empty, successful run').to.be.instanceOf(Error);
    expect((err as Error).message).to.contain('not registered');
  });

  it('migrate-down rolls the last applied batch back', async () => {
    const cmd = await DI.resolve(MigrateDownCommand);
    await cmd.execute({});

    expect(await markerTableExists(), 'down() did not actually run').to.equal(false);

    // the service DELETES the row rather than stamping RolledBackAt - the tracking table is meant
    // to hold only migrations actually present in the database. `rolled-back` as a reported state
    // is reachable only through migrate-resolve, which the failed-migration suite below covers.
    const row = (await trackingRows()).find((r) => r.Migration === TEST_MIGRATION);

    expect(row, 'the tracking row survived the rollback').to.equal(undefined);
  });

  it('migrate-status reports the rolled-back migration as pending work again', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    expect(out.find((l) => l.includes(TEST_MIGRATION))).to.contain('pending');

    // it will run again on the next migrate-up, so the database is not current
    expect(process.exitCode).to.equal(1);
  });
});

describe('orm-cli against a FAILED migration', function () {
  this.timeout(20000);

  const CONNECTION_NAME = 'orm-cli-failing';
  const TRACKING_TABLE = 'orm_cli_failing_migrations';
  const FAILING_MIGRATION = 'OrmCliBoom_2021_03_01_00_00_00';
  const BOOM = 'orm-cli test migration failed on purpose';

  const Conf = connectionConf(CONNECTION_NAME, TRACKING_TABLE);

  let orm: Orm;
  let failingType: any;

  function defineMigration() {
    @Migration(CONNECTION_NAME)
    class OrmCliBoom_2021_03_01_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        return Promise.reject(new Error(BOOM));
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    failingType = OrmCliBoom_2021_03_01_00_00_00;
  }

  const originalExitCode = process.exitCode;

  before(async () => {
    DI.clearCache();
    defineMigration();
    DI.register(Conf).as(Configuration);
    orm = await DI.resolve(Orm);
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(Conf);

      if (failingType) {
        DI.unregister(failingType);
      }

      DI.clearCache();

      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  it('migrate-up surfaces the failure rather than reporting an empty run', async () => {
    const cmd = await DI.resolve(MigrateUpCommand);

    const err = await thrownBy(() => cmd.execute({}));

    expect(err, 'a migration that threw was reported as a clean run').to.be.instanceOf(Error);
  });

  it('migrate-status marks the failed row unmistakably, points at migrate-resolve and exits 1', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    // the `!!` marker in the leftmost column is what makes the one blocking line survive being
    // skimmed in a wall of `applied`
    const line = out.find((l) => l.startsWith('!!'));

    expect(line, `no marked FAILED line in:\n${out.join('\n')}`).to.be.a('string');
    expect(line).to.contain('FAILED');
    expect(line).to.contain(FAILING_MIGRATION);

    const text = out.join('\n');
    expect(text).to.contain(`migrate-resolve --name ${FAILING_MIGRATION} --applied`);
    expect(text).to.contain(`migrate-resolve --name ${FAILING_MIGRATION} --rolled-back`);

    expect(process.exitCode).to.equal(1);
  });

  it('migrate-resolve --rolled-back clears the failure and makes it pending again', async () => {
    await (await DI.resolve(MigrateResolveCommand)).execute({ name: FAILING_MIGRATION, rolledBack: true });

    const status = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => status.execute());

    const line = out.find((l) => l.includes(FAILING_MIGRATION));

    expect(line).to.contain('rolled-back');
    expect(line).to.not.contain('FAILED');

    // rolled back is not done - it runs again on the next migrate-up
    expect(process.exitCode).to.equal(1);
  });

  it('migrate-resolve refuses a row that is not in the failed state', async () => {
    const cmd = await DI.resolve(MigrateResolveCommand);

    // the previous test already cleared it, so this row is now healthy - rewriting it would
    // destroy state nobody asked to lose
    const err = await thrownBy(() => cmd.execute({ name: FAILING_MIGRATION, applied: true }));

    expect(err, 'a row that was not failed got silently rewritten').to.be.instanceOf(Error);
    expect((err as Error).message).to.contain('not in failed state');
  });
});

describe('migrate-resolve argument validation', () => {
  const originalExitCode = process.exitCode;

  after(() => {
    process.exitCode = originalExitCode;
  });

  /**
   * Both refusals happen BEFORE `DI.resolve(Orm)`, which is why this suite needs no database:
   * booting an Orm to reject a malformed command line would open connections nobody asked for.
   */
  it('refuses --applied and --rolled-back together', async () => {
    const cmd = await DI.resolve(MigrateResolveCommand);
    const err = await thrownBy(() => cmd.execute({ name: 'Whatever_2021_01_01_00_00_00', applied: true, rolledBack: true }));

    expect(err).to.be.instanceOf(InvalidArgument);
    expect((err as Error).message).to.contain('mutually exclusive');
  });

  it('refuses neither flag', async () => {
    const cmd = await DI.resolve(MigrateResolveCommand);
    const err = await thrownBy(() => cmd.execute({ name: 'Whatever_2021_01_01_00_00_00' }));

    expect(err).to.be.instanceOf(InvalidArgument);
    expect((err as Error).message).to.contain('required');
  });
});

describe('migrate-create', () => {
  let scratch: string;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-orm-cli-'));
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('writes a migration the runner is able to read back', async () => {
    const dir = path.join(scratch, 'writes');
    const cmd = await DI.resolve(MigrateCreateCommand);

    const out = await captureStdout(() => cmd.execute({ name: 'CreateThing', dir, connection: 'some-connection' }));

    const files = fs.readdirSync(dir);
    expect(files).to.have.lengthOf(1);

    const file = files[0];
    expect(file).to.match(/^CreateThing_\d{4}(_\d{2}){5}\.ts$/);

    // the printed path is this command's machine-readable output
    expect(out).to.contain(path.join(dir, file));

    const cls = file.replace(/\.ts$/, '');

    // the generated name has to survive the runner's own parse, or the migration can never be
    // ordered - and the runner refuses the whole set when one name does not
    const match = cls.match(MIGRATION_FILE_REGEXP);
    expect(match, `${cls} is not a name MIGRATION_FILE_REGEXP accepts`).to.not.equal(null);
    expect(match![1]).to.equal('CreateThing');

    const content = fs.readFileSync(path.join(dir, file), 'utf-8');

    expect(content).to.contain(`import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';`);
    expect(content).to.contain(`@Migration('some-connection')`);
    expect(content).to.contain(`export class ${cls} extends OrmMigration {`);
    expect(content).to.contain('public async up(connection: OrmDriver): Promise<void> {');
    expect(content).to.contain('public async down(connection: OrmDriver): Promise<void> {');
  });

  it('defaults the connection to "default"', async () => {
    const dir = path.join(scratch, 'default-connection');
    const cmd = await DI.resolve(MigrateCreateCommand);

    await captureStdout(() => cmd.execute({ name: 'DefaultConn', dir }));

    const file = fs.readdirSync(dir)[0];
    expect(fs.readFileSync(path.join(dir, file), 'utf-8')).to.contain(`@Migration('default')`);
  });

  it("refuses a name that would not survive the runner's parse", async () => {
    const dir = path.join(scratch, 'refused');
    const cmd = await DI.resolve(MigrateCreateCommand);

    for (const name of ['', '2Leading', 'has space', 'has-dash', 'has_underscore', 'Semi;colon']) {
      const err = await thrownBy(() => cmd.execute({ name, dir }));
      expect(err, `"${name}" was accepted`).to.be.instanceOf(InvalidArgument);
    }

    // refused before any directory or file was touched
    expect(fs.existsSync(dir), 'a refused name still created its target directory').to.equal(false);
  });

  it('refuses a connection name it cannot safely put inside @Migration()', async () => {
    const dir = path.join(scratch, 'bad-connection');
    const cmd = await DI.resolve(MigrateCreateCommand);

    const err = await thrownBy(() => cmd.execute({ name: 'Fine', dir, connection: `x') // ` }));

    expect(err).to.be.instanceOf(InvalidArgument);
    expect(fs.existsSync(dir)).to.equal(false);
  });
});

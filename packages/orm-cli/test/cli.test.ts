/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MIGRATION_FILE_REGEXP, Migration, Orm, OrmDriver, OrmException, OrmMigration } from '@spinajs/orm';
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
 * Writes one sqlite connection plus a logger wired to nothing into a configuration object.
 *
 * Kept as a function over `this.Config` rather than living in a base class, because the suites
 * below need configuration classes with distinct NAMES: `DI.register()` deduplicates by type
 * name, so two classes handed back by the same factory - both anonymous - would collapse into
 * one registration and the second config would silently never take effect.
 */
function applyConnectionConf(config: any, connection: Record<string, unknown>) {
  // Targets are APPENDED and rules REPLACED: appending a rule would leave the packaged
  // console rule matching as well, and every framework log line would land in the mocha
  // reporter on top of the `console.log` output these tests actually assert on.
  const logger = (config.logger ?? {}) as Record<string, unknown>;
  logger.targets = [...((logger.targets as unknown[]) ?? []), { name: 'Empty', type: 'BlackHoleTarget' }];
  logger.rules = [{ name: '*', level: 'trace', target: 'Empty' }];
  config.logger = logger;

  const db = (config.db ?? {}) as Record<string, unknown>;
  db.Connections = [...((db.Connections as unknown[]) ?? []), connection];
  config.db = db;
}

/**
 * One in-memory sqlite connection, named and with its own tracking table.
 *
 * `OnStartup: false` is the load-bearing part for the suites that take the default: the Orm's
 * boot pass runs with `force: false` and honours that gate, so the migrations are still PENDING
 * when the first command runs. With it on, every assertion would be made against a database the
 * Orm had already migrated by itself, and the commands would be tested against nothing.
 *
 * `onStartup: true` is the opposite fixture - the configuration this branch's docs ship as the
 * example - and the suites that pass it are testing exactly what a command does on its way in.
 */
function connectionConf(name: string, table: string, onStartup = false): Class<FrameworkConfiguration> {
  return class extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      applyConnectionConf(this.Config, {
        Driver: 'orm-driver-sqlite',
        Filename: ':memory:',
        Name: name,
        Migration: { Table: table, OnStartup: onStartup },
      });
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

/**
 * The STATE column of one `migrate-status` line. The report is `<marker> <state> <batch>
 * <connection> <migration>`, and the marker is blank for everything but a failed row - so the
 * first token of the trimmed line is the state, or `!!` when it is FAILED.
 *
 * Worth the parse: connection names and migration names sit on the same line, so asserting that
 * a line *contains* `pending` passes on a connection called `reporting-pending` no matter what
 * its state actually is.
 */
function stateOf(line: string): string {
  return line.trim().split(/\s+/)[0];
}

/** Runs `fn` and hands back whatever it threw, or `undefined` when it did not throw. */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
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

/**
 * `--connection` on `migrate-up` / `migrate-down`. Two connections, one migration each, and the
 * whole point is what the excluded one does NOT do: a filter that only trimmed the reported list
 * would still have applied its migration and written its tracking row.
 */
describe('orm-cli --connection', function () {
  this.timeout(20000);

  /** No state word in either name - see the note on the lockout suite below. */
  const FIRST_CONNECTION = 'orm-cli-conn-one';
  const SECOND_CONNECTION = 'orm-cli-conn-two';
  const FIRST_TABLE = 'orm_cli_conn_one_migrations';
  const SECOND_TABLE = 'orm_cli_conn_two_migrations';

  const FIRST_MIGRATION = 'OrmCliConnOne_2021_07_01_00_00_00';
  const SECOND_MIGRATION = 'OrmCliConnTwo_2021_07_02_00_00_00';

  class TwoConnectionConf extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      applyConnectionConf(this.Config, { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: FIRST_CONNECTION, Migration: { Table: FIRST_TABLE, OnStartup: false } });
      applyConnectionConf(this.Config, { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: SECOND_CONNECTION, Migration: { Table: SECOND_TABLE, OnStartup: false } });
    }
  }

  let orm: Orm;
  let firstType: any;
  let secondType: any;

  /** Counted rather than spied: the count is the assertion, in both directions. */
  let firstUpRuns = 0;
  let secondUpRuns = 0;
  let firstDownRuns = 0;

  function defineMigrations() {
    @Migration(FIRST_CONNECTION)
    class OrmCliConnOne_2021_07_01_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        firstUpRuns++;
        return Promise.resolve();
      }

      public down(_connection: OrmDriver): Promise<void> {
        firstDownRuns++;
        return Promise.resolve();
      }
    }

    @Migration(SECOND_CONNECTION)
    class OrmCliConnTwo_2021_07_02_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        secondUpRuns++;
        return Promise.resolve();
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    firstType = OrmCliConnOne_2021_07_01_00_00_00;
    secondType = OrmCliConnTwo_2021_07_02_00_00_00;
  }

  const originalExitCode = process.exitCode;

  before(async () => {
    DI.clearCache();
    defineMigrations();
    DI.register(TwoConnectionConf).as(Configuration);
    orm = await DI.resolve(Orm);
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(TwoConnectionConf);
      [firstType, secondType].filter(Boolean).forEach((t) => DI.unregister(t));
      DI.clearCache();
      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  // MUST RUN FIRST: the tests below depend on exactly one of the two being applied.
  it('migrate-up --connection applies that connection and leaves the other alone', async () => {
    const cmd = await DI.resolve(MigrateUpCommand);
    await cmd.execute({ connection: FIRST_CONNECTION });

    expect(firstUpRuns, 'the requested connection did not migrate').to.equal(1);
    expect(secondUpRuns, 'the excluded connection was migrated anyway').to.equal(0);

    // The decisive one, and stronger than "no tracking row": the excluded connection's tracking
    // table does not exist at all. `ensureStorage()` is the first thing a per-connection run does,
    // so a filter that merely trimmed the reported list would have created it here.
    const tables = (await orm.Connections.get(SECOND_CONNECTION)!.select().from('sqlite_master').where('name', SECOND_TABLE).asRaw<any[]>()) as any[];
    expect(tables, `the excluded connection was reached: ${SECOND_TABLE} exists`).to.have.length(0);

    expect(process.exitCode).to.equal(0);
  });

  it('migrate-status still reports every connection, filter or no filter', async () => {
    const out = await captureStdout(() => DI.resolve(MigrateStatusCommand).then((c) => c.execute()));
    const text = out.join('\n');

    expect(stateOf(out.find((l) => l.includes(FIRST_MIGRATION))!)).to.equal('applied');
    expect(stateOf(out.find((l) => l.includes(SECOND_MIGRATION))!)).to.equal('pending');

    // the report has no --connection of its own: hiding a connection is exactly how a deploy
    // gate comes to answer "nothing to see" about the one that is behind
    expect(text).to.contain(FIRST_CONNECTION);
    expect(text).to.contain(SECOND_CONNECTION);

    expect(process.exitCode).to.equal(1);
  });

  it('migrate-down --connection rolls back only that connection', async () => {
    const cmd = await DI.resolve(MigrateDownCommand);
    await cmd.execute({ connection: FIRST_CONNECTION });

    expect(firstDownRuns).to.equal(1);
    expect(secondUpRuns, 'a rollback must not migrate the connection it was pointed away from').to.equal(0);
  });

  it('a --connection nothing answers to throws instead of reporting an empty run', async () => {
    const cmd = await DI.resolve(MigrateUpCommand);

    const err = await thrownBy(() => cmd.execute({ connection: 'orm-cli-conn-typo' }));

    expect(err, 'a typo was reported as an empty, successful run').to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('orm-cli-conn-typo');
  });
});

/**
 * The state a FAILED row cannot express: a migration that was started and never finished, because
 * the process running it was killed before it could record either outcome. Its row carries
 * `StartedAt` with neither `FinishedAt` nor `Logs`, which used to be indistinguishable from
 * "never ran" - `migrate-status` printed `pending` and the next `migrate-up` re-ran it silently.
 *
 * The row is PLANTED rather than produced: producing it means killing a process mid-run. What it
 * is, exactly, is what `upsertStart` writes and nothing ever closed.
 */
describe('orm-cli against an INTERRUPTED migration', function () {
  this.timeout(20000);

  /** No state word in either name - see the note on the lockout suite below. */
  const CONNECTION_NAME = 'orm-cli-killed-run';
  const TRACKING_TABLE = 'orm_cli_killed_migrations';
  const KILLED_MIGRATION = 'OrmCliKilled_2021_06_01_00_00_00';

  const Conf = connectionConf(CONNECTION_NAME, TRACKING_TABLE);

  let orm: Orm;
  let killedType: any;

  /** Counted rather than spied: the count is the assertion, in both directions. */
  let upRuns = 0;

  function defineMigration() {
    @Migration(CONNECTION_NAME)
    class OrmCliKilled_2021_06_01_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        upRuns++;
        return Promise.resolve();
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    killedType = OrmCliKilled_2021_06_01_00_00_00;
  }

  const originalExitCode = process.exitCode;

  before(async () => {
    DI.clearCache();
    defineMigration();
    DI.register(Conf).as(Configuration);
    orm = await DI.resolve(Orm);

    // `OnStartup: false` means the boot pass skipped this connection entirely, so its tracking
    // tables do not exist yet. `status()` calls `ensureStorage()` and changes nothing else.
    await orm.Migration.status();

    await orm.Connections.get(CONNECTION_NAME)!
      .insert()
      .into(TRACKING_TABLE)
      .values({ Migration: KILLED_MIGRATION, CreatedAt: new Date(), StartedAt: new Date(), FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 });
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(Conf);

      if (killedType) {
        DI.unregister(killedType);
      }

      DI.clearCache();
      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  // MUST RUN FIRST: the migrate-resolve test below clears the row these assertions are about.
  it('migrate-status reports it as INTERRUPTED rather than as ordinary pending work', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    // `??` in the leftmost column, the counterpart of the failed row's `!!`: this line blocks
    // nothing, and the next migrate-up re-runs it whether or not anybody looked
    const line = out.find((l) => l.startsWith('??'));

    expect(line, `no marked INTERRUPTED line in:\n${out.join('\n')}`).to.be.a('string');
    expect(line).to.contain('INTERRUPTED');
    expect(line).to.contain(KILLED_MIGRATION);

    const text = out.join('\n');

    // counted apart from plain pending, or the summary would say "1 pending" against a table in
    // which no line reads `pending`
    expect(text).to.contain('1 interrupted');
    expect(text).to.contain(`migrate-resolve --name ${KILLED_MIGRATION} --applied`);
    expect(text).to.contain(`migrate-resolve --name ${KILLED_MIGRATION} --rolled-back`);

    // it is still work the next migrate-up will do, so the deploy gate says "not current"
    expect(process.exitCode).to.equal(1);
  });

  it('migrate-resolve --applied accepts it, which is the only lever an operator has on it', async () => {
    // the whole point of reporting the state: without this the row is unreachable except by
    // editing the tracking table by hand
    await (await DI.resolve(MigrateResolveCommand)).execute({ name: KILLED_MIGRATION, applied: true });

    const rows = (await orm.Connections.get(CONNECTION_NAME)!.select().from(TRACKING_TABLE).asRaw<any[]>()) as any[];
    const row = rows.find((r) => r.Migration === KILLED_MIGRATION);

    expect(row.FinishedAt, 'the row was not recorded as applied').to.not.equal(null);
    // stamped exactly as a real finish would have been, so a later default rollback reaches it
    expect(row.Batch).to.equal(1);

    // and the migration must not be applied a second time over a schema that already has it
    const up = await DI.resolve(MigrateUpCommand);
    await up.execute({});

    expect(upRuns, `${KILLED_MIGRATION} ran after being resolved as applied`).to.equal(0);
    expect(process.exitCode).to.equal(0);
  });
});

/**
 * The trap: a connection with `Migration.OnStartup: true` - the configuration the ORM docs ship
 * as their example - holding a migration in the FAILED state.
 *
 * Every command starts by resolving an Orm, and an ordinary resolve ends with the boot migration
 * pass, which refuses to run at all while such a row is there. So every invocation died on the
 * row it was called about - including `migrate-resolve`, the one command that can clear it, and
 * the one the error message names as the remedy. The only ways out were editing the tracking
 * table or the configuration by hand.
 *
 * `:memory:` cannot express this. The failed row has to already be in the database when the Orm
 * the command resolves opens the connection, and every sqlite handle gets its own private
 * in-memory database - so the row would be invisible. Hence the temp file.
 */
describe('orm-cli against a FAILED row on a Migration.OnStartup connection', function () {
  this.timeout(20000);

  /**
   * Neither name may contain a state word - `pending`, `applied`, `rolled-back`. The connection
   * is printed on the same status line as the STATE column, so a `to.contain('rolled-back')`
   * would pass on a line whose state says something else entirely.
   */
  const CONNECTION_NAME = 'orm-cli-startup-lockout';
  const TRACKING_TABLE = 'orm_cli_lockout_migrations';
  const FAILING_MIGRATION = 'OrmCliStartupBoom_2021_04_01_00_00_00';
  const BOOM = 'orm-cli startup-lockout migration failed on purpose';

  let scratch = '';
  let dbFile = '';

  /**
   * Read at configuration-resolve time, so one registered class covers both phases: the fixture
   * is planted through a gated connection this suite can hold and dispose, and the commands then
   * run against the same database with the gate ON. Two classes would not work - see
   * `applyConnectionConf`.
   */
  let onStartup = false;

  class StartupFailedConf extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      applyConnectionConf(this.Config, {
        Driver: 'orm-driver-sqlite',
        Filename: dbFile,
        Name: CONNECTION_NAME,

        // one handle per Orm, so as little as possible is left holding the file at cleanup
        Pool: { Max: 1 },

        Migration: { Table: TRACKING_TABLE, OnStartup: onStartup },
      });
    }
  }

  let failingType: any;

  /** Assigned by the tests, so `after()` disposes only an Orm that really was resolved. */
  let orm: Orm | undefined;

  function defineMigration() {
    @Migration(CONNECTION_NAME)
    class OrmCliStartupBoom_2021_04_01_00_00_00 extends OrmMigration {
      public up(_connection: OrmDriver): Promise<void> {
        return Promise.reject(new Error(BOOM));
      }

      public down(_connection: OrmDriver): Promise<void> {
        return Promise.resolve();
      }
    }

    failingType = OrmCliStartupBoom_2021_04_01_00_00_00;
  }

  const originalExitCode = process.exitCode;

  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-orm-cli-lockout-'));
    dbFile = path.join(scratch, 'lockout.sqlite');

    DI.clearCache();
    defineMigration();
    DI.register(StartupFailedConf).as(Configuration);

    // Phase 1 - plant the failed row the way a real failure does: a real migration whose `up()`
    // throws, through the real service. The gate is off only so this Orm can be resolved, held
    // and disposed; what the tests need is the row it leaves behind.
    const seed = await DI.resolve(Orm);
    const err = await thrownBy(() => seed.Migration.up());

    expect(err, 'the fixture needs a migration that really failed').to.be.instanceOf(OrmException);

    // Guard for every assertion below: FAILED is `FinishedAt` NULL *and* `Logs` set, and that
    // pair is exactly what blocks a migration run. A fixture that recorded anything else would
    // make the tests pass against a database that was never blocking anything.
    const rows = (await seed.Connections.get(CONNECTION_NAME)!.select().from(TRACKING_TABLE).asRaw<any[]>()) as any[];
    const row = rows.find((r) => r.Migration === FAILING_MIGRATION);

    expect(row, `no tracking row for ${FAILING_MIGRATION}, got: ${JSON.stringify(rows)}`).to.not.equal(undefined);
    expect(row.FinishedAt, 'the fixture row is not in the failed state').to.equal(null);
    expect(row.Logs, 'the fixture row carries no failure log, so nothing would block').to.be.a('string');

    await seed.dispose();

    // Phase 2 - same database, now with migrations running at boot. Nothing resolves an Orm from
    // here on: the commands have to be the first thing that does, exactly as in a CLI process.
    onStartup = true;
    DI.clearCache();
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(StartupFailedConf);

      if (failingType) {
        DI.unregister(failingType);
      }

      DI.clearCache();
      process.exitCode = originalExitCode;

      // Best effort: a test that failed leaves a connected driver nobody has a handle to, and
      // windows refuses to remove a file sqlite still holds open. A strict cleanup would turn
      // one real failure into two, the second saying nothing about the code under test.
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // nothing to do about it, and nothing depends on it
      }
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  // MUST RUN FIRST, with the one below it: it asserts on the failed row, which the
  // `migrate-resolve` test clears. Add new cases after those two, never between them.
  it('an ordinary DI.resolve(Orm) is still blocked by the failed row', async () => {
    // The opt-out is opt-in: nothing about this branch weakens what a failed migration does to an
    // application that boots normally. It is also what makes the next test non-vacuous - the
    // fixture really does refuse a boot migration pass.
    const err = await thrownBy(() => DI.resolve(Orm));

    expect(err, 'a failed migration no longer blocks an ordinary Orm boot').to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('blocks migration runs');
    expect((err as Error).message).to.contain(FAILING_MIGRATION);
  });

  it('migrate-resolve clears the failed row instead of dying on it', async () => {
    // The command resolves its own Orm - and with the boot migration pass suppressed, that
    // resolve gets as far as the command body. Without the suppression this line threw
    // `Migration ... failed previously and blocks migration runs` before `resolve()` was reached.
    await (await DI.resolve(MigrateResolveCommand)).execute({ name: FAILING_MIGRATION, rolledBack: true });

    // the Orm the command resolved, from the cache - not a second one
    orm = await DI.resolve(Orm);

    const rows = (await orm.Connections.get(CONNECTION_NAME)!.select().from(TRACKING_TABLE).asRaw<any[]>()) as any[];
    const row = rows.find((r) => r.Migration === FAILING_MIGRATION);

    expect(row, 'the tracking row disappeared').to.not.equal(undefined);
    expect(row.Logs, 'Logs survived, so the row still blocks every later run').to.equal(null);
    expect(row.RolledBackAt, 'the row was not recorded as rolled back').to.not.equal(null);
  });

  it('migrate-status runs on the same connection and reports the migration as pending work', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    const line = out.find((l) => l.includes(FAILING_MIGRATION));

    expect(line, `no status line for ${FAILING_MIGRATION} in:\n${out.join('\n')}`).to.be.a('string');

    // the STATE column itself, not merely the line: a state word can appear in the connection
    // name or the migration name and make a `contain` assertion pass on the wrong row
    expect(stateOf(line!), `status line: ${line}`).to.equal('rolled-back');

    // rolled back is not done - it runs again on the next migrate-up
    expect(process.exitCode).to.equal(1);
  });
});

/**
 * Consequence B of the same root cause, and the one that fails silently: `migrate-status` is
 * sold as a deploy gate - "is this database current?" - but an ordinary `DI.resolve(Orm)` applies
 * every pending migration on every `Migration.OnStartup` connection BEFORE `status()` is called.
 * The report then truthfully says "all applied" and exits 0, having itself run the DDL the gate
 * existed to hold back.
 *
 * `:memory:` is enough here, unlike the suite above: nothing has to survive between two Orms -
 * the command's own resolve is the only one, which is the point.
 */
describe('migrate-status against a Migration.OnStartup connection with pending work', function () {
  this.timeout(20000);

  /** No state word in the name - see the note on the suite above. */
  const CONNECTION_NAME = 'orm-cli-startup-gate';
  const TRACKING_TABLE = 'orm_cli_gate_migrations';
  const MARKER_TABLE = 'orm_cli_startup_marker';
  const PENDING_MIGRATION = 'OrmCliStartupPending_2021_05_01_00_00_00';

  const Conf = connectionConf(CONNECTION_NAME, TRACKING_TABLE, true);

  let pendingType: any;
  let orm: Orm | undefined;

  /** Counted rather than spied: the count is the assertion, in both directions. */
  let upRuns = 0;

  function defineMigration() {
    @Migration(CONNECTION_NAME)
    class OrmCliStartupPending_2021_05_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        upRuns++;

        await connection.schema().createTable(MARKER_TABLE, (table) => {
          table.int('Id').primaryKey().autoIncrement();
        });
      }

      public async down(connection: OrmDriver): Promise<void> {
        await connection.schema().dropTable(MARKER_TABLE);
      }
    }

    pendingType = OrmCliStartupPending_2021_05_01_00_00_00;
  }

  const originalExitCode = process.exitCode;

  before(() => {
    DI.clearCache();
    defineMigration();
    DI.register(Conf).as(Configuration);

    // deliberately no `DI.resolve(Orm)` here: the command has to be the first thing in the
    // process that resolves one, which is the only situation a CLI is ever in
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(Conf);

      if (pendingType) {
        DI.unregister(pendingType);
      }

      DI.clearCache();
      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  async function markerTableExists(connection: OrmDriver): Promise<boolean> {
    const rows = (await connection.select().from('sqlite_master').where('name', MARKER_TABLE).asRaw<any[]>()) as any[];
    return rows.length > 0;
  }

  // MUST RUN FIRST - the migrate-up below applies the very migration this one asserts is still
  // pending and unapplied.
  it('reports the pending migration without applying it', async () => {
    const cmd = await DI.resolve(MigrateStatusCommand);
    const out = await captureStdout(() => cmd.execute());

    const line = out.find((l) => l.includes(PENDING_MIGRATION));

    expect(line, `no status line for ${PENDING_MIGRATION} in:\n${out.join('\n')}`).to.be.a('string');
    expect(stateOf(line!), 'the report describes a database it had just migrated itself').to.equal('pending');

    // the deploy gate: an un-run migration means "this database is not current". Resolving the
    // Orm the ordinary way would have made it current first, and this would be 0.
    expect(process.exitCode).to.equal(1);

    expect(upRuns, 'migrate-status ran the migration it was asked to report on').to.equal(0);

    // the Orm the command resolved, from the cache - the schema really is untouched, not merely
    // un-instrumented
    orm = await DI.resolve(Orm);
    const connection = orm.Connections.get(CONNECTION_NAME)!;

    expect(await markerTableExists(connection), `${MARKER_TABLE} exists, so up() executed`).to.equal(false);

    const rows = (await connection.select().from(TRACKING_TABLE).asRaw<any[]>()) as any[];
    expect(
      rows.find((r) => r.Migration === PENDING_MIGRATION),
      'a tracking row exists, so the report recorded a migration as applied',
    ).to.equal(undefined);
  });

  it('migrate-up still applies it - the suppression is about booting, not about migrating', async () => {
    const cmd = await DI.resolve(MigrateUpCommand);
    await cmd.execute({});

    expect(upRuns, 'migrate-up applied nothing').to.equal(1);

    orm = await DI.resolve(Orm);
    expect(await markerTableExists(orm.Connections.get(CONNECTION_NAME)!), 'up() did not actually run').to.equal(true);

    expect(process.exitCode).to.equal(0);
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

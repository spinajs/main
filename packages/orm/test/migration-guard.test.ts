import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, NewInstance } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';
import { IMigrationRecord, IOrmMigrationGuardOptions, MIGRATION_TABLE_NAME, Migration, Orm, OrmDriver, OrmMigration, OrmMigrationGuard, PendingMigrationsException, SelectQueryBuilder, TableExistsQueryBuilder, pendingMigrationsMessage, resolveMigrationTool } from '../src/index.js';
import { FakeSqliteDriver, logText } from './misc.js';

const expect = chai.expect;

interface IFakeDb {
  tables: Set<string>;
  rows: IMigrationRecord[];
}

/** The fake databases, by connection name. */
const DBS = new Map<string, IFakeDb>();

/** Every statement the fake executed, with the connection it ran on. */
let EXECUTED: Array<{ connection: string; builder: unknown }> = [];

let migrationCheck: string | undefined;
let connectionChecks: Record<string, string | undefined> = {};
let onStartup: string[] = [];

const now = new Date();

function applied(name: string): IMigrationRecord {
  return { Migration: name, CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Checksum: null, Batch: 1 };
}

function db(connection: string): IFakeDb {
  return DBS.get(connection)!;
}

function track(connection: string, ...rows: IMigrationRecord[]) {
  db(connection).tables.add(MIGRATION_TABLE_NAME);
  db(connection).rows.push(...rows);
}

@NewInstance()
class GuardTestDriver extends FakeSqliteDriver {
  public async execute(b: any): Promise<any> {
    EXECUTED.push({ connection: this.Options.Name, builder: b });

    if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
      return db(this.Options.Name).rows;
    }

    if (b instanceof TableExistsQueryBuilder) {
      return db(this.Options.Name).tables.has(b.Table) ? [{ 1: 1 }] : [];
    }

    return b instanceof SelectQueryBuilder ? [] : [{ 1: 1 }];
  }
}

class GuardTestConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    const connection = (name: string) => ({
      Driver: 'guard-test-driver',
      Name: name,
      Migration: {
        ...(connectionChecks[name] ? { Check: connectionChecks[name] } : {}),
        ...(onStartup.includes(name) ? { OnStartup: true } : {}),
      },
    });

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        StrictTableCheck: false,
        ...(migrationCheck ? { MigrationCheck: migrationCheck } : {}),
        Aliases: { legacy: 'main' },
        Connections: [connection('main'), connection('audit'), connection('empty')],
      },
    };
  }
}

const USERS = 'Users_2026_10_01_00_00_00';
const ORDERS = 'Orders_2026_10_02_00_00_00';
const AUDIT = 'Audit_2026_10_03_00_00_00';

function defineMigrations() {
  // registered out of run order on purpose: the report must not depend on registration order
  @Migration('main')
  class Orders_2026_10_02_00_00_00 extends OrmMigration {
    public async up(_c: OrmDriver) {}
    public async down() {}
  }

  @Migration('audit')
  class Audit_2026_10_03_00_00_00 extends OrmMigration {
    public async up(_c: OrmDriver) {}
    public async down() {}
  }

  @Migration('main')
  class Users_2026_10_01_00_00_00 extends OrmMigration {
    public async up(_c: OrmDriver) {}
    public async down() {}
  }

  return [Orders_2026_10_02_00_00_00, Audit_2026_10_03_00_00_00, Users_2026_10_01_00_00_00];
}

describe('OrmMigrationGuard', function () {
  this.timeout(10000);

  let preRegistered: unknown[] = [];
  let orm: Orm;

  async function boot() {
    await resolveMigrationTool();
    orm = await DI.resolve(Orm);
  }

  const guardOf = (options?: IOrmMigrationGuardOptions) => DI.resolve(OrmMigrationGuard, [options]);

  async function guardWithWarnSpy() {
    const guard = await guardOf();
    return { guard, warn: sinon.spy(guard['Log'], 'warn') };
  }

  const failure = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<PendingMigrationsException>;
  const checkFailure = async () => failure((await guardOf()).check(orm));

  beforeEach(() => {
    DI.clearCache();
    DI.register(GuardTestConf).as(Configuration);
    DI.register(GuardTestDriver).as('guard-test-driver');

    DBS.clear();
    ['main', 'audit', 'empty'].forEach((c) => DBS.set(c, { tables: new Set(), rows: [] }));
    EXECUTED = [];
    migrationCheck = undefined;
    connectionChecks = {};
    onStartup = [];

    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
  });

  afterEach(() => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t);
      }
    }

    DI.unregister(GuardTestConf);
    DI.unregister(GuardTestDriver);
    DI.clearCache();
    sinon.restore();
  });

  it('throws PendingMigrationsException naming every pending migration per connection and the command to run', async () => {
    defineMigrations();
    await boot();

    const err = await checkFailure();

    expect(err).to.be.instanceOf(PendingMigrationsException);
    expect(err.pending).to.deep.equal([
      { name: AUDIT, connection: 'audit' },
      { name: USERS, connection: 'main' },
      { name: ORDERS, connection: 'main' },
    ]);
    expect(err.failed).to.deep.equal([]);
    expect(err.message).to.equal(`Database is not migrated: 1 pending migration(s) on connection audit (${AUDIT}); 2 on connection main (${USERS}, ${ORDERS}). The application never migrates on its own: run "npx spinajs migrate-up" (add --env <env> when the application runs with one), then start it again.`);
  });

  it('passes once everything is migrated, and reads without creating anything on a connection with nothing registered', async () => {
    defineMigrations();
    await boot();
    track('main', applied(USERS), applied(ORDERS));
    track('audit', applied(AUDIT));

    expect(await (await guardOf()).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
    expect(EXECUTED.filter((e) => e.connection === 'empty')).to.have.lengthOf(0);
    expect(db('empty').tables.has(MIGRATION_TABLE_NAME)).to.be.false;
  });

  it('never writes: a missing tracking table makes everything pending and stays missing', async () => {
    defineMigrations();
    await boot();
    EXECUTED = [];

    await checkFailure();

    expect(db('main').tables.has(MIGRATION_TABLE_NAME)).to.be.false;
    expect(EXECUTED.filter((e) => e.builder instanceof SelectQueryBuilder && e.connection === 'main')).to.have.lengthOf(0);
    expect(EXECUTED.every((e) => e.builder instanceof SelectQueryBuilder || e.builder instanceof TableExistsQueryBuilder)).to.be.true;
  });

  it('counts a rolled back or never finished migration as pending', async () => {
    defineMigrations();
    await boot();
    track('main', { ...applied(USERS), RolledBackAt: now }, { ...applied(ORDERS), FinishedAt: null });
    track('audit', applied(AUDIT));

    const err = await checkFailure();

    expect(err.pending.map((p) => p.name)).to.deep.equal([USERS, ORDERS]);
    expect(err.failed).to.deep.equal([]);
  });

  it('names a FAILED migration with migrate-status and migrate-resolve', async () => {
    defineMigrations();
    await boot();
    track('main', { ...applied(USERS), FinishedAt: null, Logs: 'boom' }, applied(ORDERS));
    track('audit', applied(AUDIT));

    const err = await checkFailure();

    expect(err.failed).to.deep.equal([{ name: USERS, connection: 'main' }]);
    expect(err.pending).to.deep.equal([]);
    expect(err.message).to.contain('npx spinajs migrate-status');
    expect(err.message).to.contain(`migrate-resolve --name ${USERS} --applied`);
  });

  it('Check: warn logs the same text and does not throw', async () => {
    connectionChecks = { main: 'warn' };
    defineMigrations();
    await boot();
    track('audit', applied(AUDIT));

    const { guard, warn } = await guardWithWarnSpy();
    const report = await guard.check(orm);

    expect(report.pending).to.deep.equal([
      { name: USERS, connection: 'main' },
      { name: ORDERS, connection: 'main' },
    ]);
    expect(report.warned).to.deep.equal(['main']);
    expect(
      warn
        .getCalls()
        .map(logText)
        .filter((l) => l.startsWith('Database is not migrated')),
    ).to.deep.equal([
      pendingMigrationsMessage(
        [
          { name: USERS, connection: 'main' },
          { name: ORDERS, connection: 'main' },
        ],
        [],
      ),
    ]);
  });

  it('Check: off does not read the connection', async () => {
    connectionChecks = { main: 'off' };
    defineMigrations();
    await boot();
    track('audit', applied(AUDIT));
    EXECUTED = [];

    expect(await (await guardOf()).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
    expect(EXECUTED.filter((e) => e.connection === 'main')).to.have.lengthOf(0);
  });

  it('db.MigrationCheck sets the default and a connection Check overrides it', async () => {
    migrationCheck = 'warn';
    connectionChecks = { audit: 'fail' };
    defineMigrations();
    await boot();

    const err = await checkFailure();

    expect(err.pending).to.deep.equal([{ name: AUDIT, connection: 'audit' }]);

    track('audit', applied(AUDIT));

    const report = await (await guardOf()).check(orm);
    expect(report.warned).to.deep.equal(['main']);
  });

  it('db.MigrationCheck: off skips every connection', async () => {
    migrationCheck = 'off';
    defineMigrations();
    await boot();

    expect(await (await guardOf()).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
  });

  it('ignores applied rows that no registered migration matches: the database may be ahead of this release', async () => {
    defineMigrations();
    await boot();
    track('main', applied(USERS), applied(ORDERS), applied('Gone_2026_09_01_00_00_00'), { ...applied('Newer_2026_12_01_00_00_00'), FinishedAt: null, Logs: 'boom' });
    track('audit', applied(AUDIT));

    expect(await (await guardOf()).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
  });

  it('reads a row written before the tracking columns existed as applied', async () => {
    defineMigrations();
    await boot();
    const legacy = (name: string) => ({ Migration: name, CreatedAt: now } as IMigrationRecord);
    track('main', legacy(USERS), legacy(ORDERS));
    track('audit', legacy(AUDIT));

    expect(await (await guardOf()).check(orm)).to.deep.equal({ pending: [], failed: [], warned: [] });
  });

  it('warns once per connection that still sets Migration.OnStartup, and never migrates', async () => {
    onStartup = ['main', 'audit'];
    defineMigrations();
    await boot();
    EXECUTED = [];

    const { guard, warn } = await guardWithWarnSpy();
    const err = await failure(guard.check(orm));

    const lines = warn
      .getCalls()
      .map(logText)
      .filter((l) => l.includes('OnStartup'));

    expect(lines).to.have.members(['db.Connections[main].Migration.OnStartup is ignored: the application never migrates. Run "npx spinajs migrate-up" as a deploy step and remove the key.', 'db.Connections[audit].Migration.OnStartup is ignored: the application never migrates. Run "npx spinajs migrate-up" as a deploy step and remove the key.']);
    expect(err.pending).to.have.lengthOf(3);
    expect(EXECUTED.some((e) => !(e.builder instanceof SelectQueryBuilder || e.builder instanceof TableExistsQueryBuilder))).to.be.false;
  });

  it('an alias and its connection are checked once', async () => {
    onStartup = ['main'];

    @Migration('legacy')
    class ViaAlias_2026_10_04_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down() {}
    }

    void ViaAlias_2026_10_04_00_00_00;
    defineMigrations();
    await boot();
    EXECUTED = [];

    const { guard, warn } = await guardWithWarnSpy();
    const err = await failure(guard.check(orm));

    expect(err.pending.filter((p) => p.connection === 'main').map((p) => p.name)).to.deep.equal([USERS, ORDERS, 'ViaAlias_2026_10_04_00_00_00']);
    expect(EXECUTED.filter((e) => e.connection === 'main' && e.builder instanceof TableExistsQueryBuilder)).to.have.lengthOf(1);
    expect(
      warn
        .getCalls()
        .map(logText)
        .filter((l) => l.includes('OnStartup')),
    ).to.have.lengthOf(1);
  });

  it('Enabled is false only when the option says so', async () => {
    expect((await guardOf()).Enabled).to.be.true;
    expect((await guardOf({})).Enabled).to.be.true;
    expect((await guardOf({ Enabled: false })).Enabled).to.be.false;
  });
});

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer, NewInstance } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';
import { Connection, extractModelDescriptor, IColumnDescriptor, IMigrationRecord, InsertQueryBuilder, MIGRATION_TABLE_NAME, Migration, MigrationTransactionMode, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, OrmMigrationGuard, OrmMigrator, PendingMigrationsException, Primary, resolveMigrationTool, SelectQueryBuilder, TableExistsQueryBuilder, TableQueryBuilder, UpdateQueryBuilder } from '../src/index.js';
import { migrateTestDatabase } from '../src/testing/index.js';
import { FakeSqliteDriver } from './misc.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CONNECTION = 'boot-guard';
const TRACKING_COLUMNS = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'];

/**
 * One database file shared by every container of a test: the tool and the application are separate containers, as
 * they are separate processes in a deploy. Table name to column names, and the tracking table's rows.
 */
const TABLES = new Map<string, string[]>();
let RECORDS: IMigrationRecord[] = [];
let seeded: string[] = [];

let migrationConfig: Record<string, unknown> = {};
let migrationCheck: string | undefined;

function columnDescriptor(name: string): IColumnDescriptor {
  return {
    Type: 'INT',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: 'INT',
    Unsigned: false,
    Nullable: true,
    PrimaryKey: name === 'Id',
    AutoIncrement: false,
    Name: name,
    Converter: null,
    Schema: CONNECTION,
    Unique: false,
    Uuid: false,
    Ignore: false,
    IsForeignKey: false,
    ForeignKeyDescription: null,
    Aggregate: false,
    Virtual: false,
  };
}

@NewInstance()
class BootGuardDriver extends FakeSqliteDriver {
  public async execute(b: any): Promise<any> {
    if (b instanceof SelectQueryBuilder) {
      return b.Table === MIGRATION_TABLE_NAME && TABLES.has(MIGRATION_TABLE_NAME) ? RECORDS.map((r) => ({ ...r })) : [];
    }

    if (b instanceof TableExistsQueryBuilder) {
      return TABLES.has(b.Table) ? [{ 1: 1 }] : [];
    }

    if (b instanceof TableQueryBuilder) {
      TABLES.set(
        b.Table,
        b.Columns.map((c) => c.Name),
      );
    } else if (b instanceof InsertQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
      RECORDS.push({ Migration: b.getColumnValues('Migration')[0] as string, CreatedAt: new Date(), StartedAt: new Date(), FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 });
    } else if (b instanceof UpdateQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
      // the service closes one row at a time, so the open row is the one a FinishedAt or Logs update is about
      const patch = b.Value as Partial<IMigrationRecord>;
      if (patch.FinishedAt || patch.Logs) {
        Object.assign(RECORDS.find((r) => !r.FinishedAt && !r.Logs) ?? {}, patch);
      }
    }

    return [{ 1: 1 }];
  }

  public async tableInfo(table: string): Promise<IColumnDescriptor[]> {
    // a missing table answers null like a real driver, which the abstract signature does not declare
    return TABLES.has(table) ? TABLES.get(table)!.map(columnDescriptor) : (null as unknown as IColumnDescriptor[]);
  }
}

class BootGuardConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        StrictTableCheck: true,
        ...(migrationCheck ? { MigrationCheck: migrationCheck } : {}),
        Connections: [{ Driver: 'boot-guard-driver', Name: CONNECTION, Migration: { Transaction: { Mode: MigrationTransactionMode.None }, ...migrationConfig } }],
      },
    };
  }
}

function defineSchema() {
  @Connection(CONNECTION)
  @Model('boot_guard_users')
  class BootGuardUser extends ModelBase {
    @Primary()
    public Id: number;

    public Email: string;
  }

  @Migration(CONNECTION)
  class BootGuardCreateUsers_2026_01_01_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver) {
      await connection.schema().createTable('boot_guard_users', (t) => {
        t.int('Id').primaryKey();
        t.string('Email');
      });
    }

    public async down() {}

    public async data() {
      seeded.push(this.constructor.name);
    }
  }

  return { BootGuardUser, BootGuardCreateUsers_2026_01_01_00_00_00 };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('Orm boot guard: the Orm checks the migrations and never applies them', function () {
  this.timeout(10000);

  let types: ReturnType<typeof defineSchema>;
  let tool: IContainer;
  let app: IContainer;
  let preRegistered: unknown[] = [];

  function createTrackingTables() {
    TABLES.set(MIGRATION_TABLE_NAME, TRACKING_COLUMNS);
    TABLES.set(`${MIGRATION_TABLE_NAME}_lock`, ['Id', 'AcquiredAt', 'Owner']);
  }

  beforeEach(() => {
    DI.clearCache();
    DI.register(BootGuardConf).as(Configuration);
    DI.register(BootGuardDriver).as('boot-guard-driver');

    TABLES.clear();
    RECORDS = [];
    seeded = [];
    migrationConfig = {};
    migrationCheck = undefined;

    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
    types = defineSchema();
    tool = DI.child();
    app = DI.child();
  });

  afterEach(() => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t);
      }
    }

    DI.unregister(types.BootGuardUser);
    DI.unregister(BootGuardConf);
    DI.unregister(BootGuardDriver);
    DI.clearCache();
    sinon.restore();
  });

  it('resolving the Orm on a database with pending migrations rejects with PendingMigrationsException, applies nothing and closes the connections', async () => {
    const up = sinon.spy(types.BootGuardCreateUsers_2026_01_01_00_00_00.prototype, 'up');
    const disconnect = sinon.spy(BootGuardDriver.prototype, 'disconnect');

    const err = await rejection(Promise.resolve(app.resolve(Orm)));

    expect(err).to.be.instanceOf(PendingMigrationsException);
    expect((err as PendingMigrationsException).pending).to.deep.equal([{ name: types.BootGuardCreateUsers_2026_01_01_00_00_00.name, connection: CONNECTION }]);
    expect((err as Error).message).to.contain('npx spinajs migrate-up');
    expect(app.get(Orm)).to.be.undefined;
    expect(disconnect.called).to.be.true;
    expect(up.called).to.be.false;
    expect(TABLES.has('boot_guard_users')).to.be.false;
    expect(TABLES.has(MIGRATION_TABLE_NAME), 'the check never creates the tracking table').to.be.false;
  });

  it('resolving the Orm after migrate-up succeeds, reads table info and runs no data()', async () => {
    createTrackingTables();
    await migrateTestDatabase(tool);
    expect(seeded, 'the explicit run seeds').to.deep.equal([types.BootGuardCreateUsers_2026_01_01_00_00_00.name]);
    seeded.length = 0;

    const up = sinon.spy(types.BootGuardCreateUsers_2026_01_01_00_00_00.prototype, 'up');
    const orm = await app.resolve(Orm);

    expect(orm).to.not.equal(tool.get(Orm));
    expect(seeded).to.deep.equal([]);
    expect(up.called).to.be.false;
    expect(extractModelDescriptor(types.BootGuardUser)!.Columns.map((c) => c.Name)).to.include.members(['Id', 'Email']);
  });

  for (const value of [true, false]) {
    it(`a config that still sets Migration.OnStartup ( ${String(value)} ) fails the Orm resolve with an OrmException naming the key and npx spinajs migrate-up, and migrates nothing`, async () => {
      createTrackingTables();
      migrationConfig = { OnStartup: value };
      const up = sinon.spy(types.BootGuardCreateUsers_2026_01_01_00_00_00.prototype, 'up');
      const disconnect = sinon.spy(BootGuardDriver.prototype, 'disconnect');

      const err = await rejection(Promise.resolve(app.resolve(Orm)));

      expect(err).to.be.instanceOf(OrmException);
      expect(err).to.not.be.instanceOf(PendingMigrationsException);
      expect((err as Error).message).to.equal(`Migration.OnStartup is no longer supported (set in db.Connections[${CONNECTION}].Migration.OnStartup): the application never migrates. Remove the key and run "npx spinajs migrate-up" as a deploy step.`);
      expect(up.called).to.be.false;
      expect(RECORDS).to.deep.equal([]);
      expect(disconnect.called).to.be.true;
    });
  }

  it('db.MigrationCheck warn boots over a pending migration and applies nothing', async () => {
    migrationCheck = 'warn';
    // the model's table exists from an earlier release, so only the migration is missing
    TABLES.set('boot_guard_users', ['Id', 'Email']);
    const up = sinon.spy(types.BootGuardCreateUsers_2026_01_01_00_00_00.prototype, 'up');

    const orm = await app.resolve(Orm);

    expect(app.get(Orm)).to.equal(orm);
    expect(up.called).to.be.false;
    expect(RECORDS).to.deep.equal([]);
  });

  it('db.StrictTableCheck still fails a migrated database whose model has no table', async () => {
    createTrackingTables();
    await migrateTestDatabase(tool);

    @Connection(CONNECTION)
    @Model('boot_guard_without_migration')
    class BootGuardOrphan extends ModelBase {
      @Primary()
      public Id: number;
    }

    try {
      const err = await rejection(Promise.resolve(app.resolve(Orm)));

      expect(err).to.be.instanceOf(OrmException);
      expect(err).to.not.be.instanceOf(PendingMigrationsException);
      expect((err as Error).message).to.equal(`Missing tables (db.StrictTableCheck): model BootGuardOrphan: table boot_guard_without_migration on connection ${CONNECTION}. Create them (run their migrations) or set db.StrictTableCheck to false`);
    } finally {
      DI.unregister(BootGuardOrphan);
    }
  });

  it('resolveMigrationTool() resolves the Orm without the guard or the strict check, on an empty database', async () => {
    const up = sinon.spy(types.BootGuardCreateUsers_2026_01_01_00_00_00.prototype, 'up');

    const migrator = await resolveMigrationTool(tool);

    expect(migrator.Orm).to.equal(tool.get(Orm));
    expect(tool.get(OrmMigrationGuard)?.Enabled).to.be.false;
    expect(up.called).to.be.false;
    expect(TABLES.size, 'nothing is created on the way in').to.equal(0);
  });

  it('a migration tool in a child container gets its own disabled guard, not the enabled one an application left in the parent', async () => {
    createTrackingTables();
    const appGuard = await DI.resolve(OrmMigrationGuard);

    const { orm } = await migrateTestDatabase(tool);

    expect(appGuard.Enabled).to.be.true;
    expect(tool.get(OrmMigrationGuard)?.Enabled).to.be.false;
    expect(orm).to.equal(tool.get(Orm));
    expect(TABLES.has('boot_guard_users')).to.be.true;
  });

  it('resolving the tool twice in one container reuses the Orm and the migrator', async () => {
    const first = await resolveMigrationTool(tool);
    const second = await resolveMigrationTool(tool);

    expect(second).to.equal(first);
    expect(second.Orm).to.equal(first.Orm);
  });

  it('resolving the tool after only the Orm was uncached refuses the migrator left over the earlier Orm; uncaching both works', async () => {
    await resolveMigrationTool(tool);
    tool.uncache(Orm);

    await expect(resolveMigrationTool(tool)).to.be.rejectedWith('The cached OrmMigrator runs over an Orm that is no longer cached');

    tool.uncache(OrmMigrator);
    const migrator = await resolveMigrationTool(tool);
    expect(migrator.Orm).to.equal(tool.get(Orm));
  });

  it("migrate() rejects with the migration's error and records it FAILED; the next Orm resolve rejects naming the FAILED migration", async () => {
    createTrackingTables();
    const boom = new Error('boom');

    @Migration(CONNECTION)
    class BootGuardThrows_2026_01_02_00_00_00 extends OrmMigration {
      public async up() {
        throw boom;
      }

      public async down() {}
    }

    const migrator = await resolveMigrationTool(tool);
    const err = await rejection(migrator.migrate());

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message)
      .to.contain(BootGuardThrows_2026_01_02_00_00_00.name)
      .and.to.contain('boom');
    expect((err as OrmException).inner).to.equal(boom);
    expect(RECORDS.find((r) => r.Migration === BootGuardThrows_2026_01_02_00_00_00.name)!.Logs).to.contain('boom');
    expect(seeded, 'a run that failed seeds nothing, not even the migration applied before the failure').to.deep.equal([]);

    const boot = await rejection(Promise.resolve(app.resolve(Orm)));

    expect(boot).to.be.instanceOf(PendingMigrationsException);
    expect((boot as PendingMigrationsException).failed).to.deep.equal([{ name: BootGuardThrows_2026_01_02_00_00_00.name, connection: CONNECTION }]);
    expect((boot as Error).message)
      .to.contain(`Migration ${BootGuardThrows_2026_01_02_00_00_00.name} on connection ${CONNECTION} FAILED in an earlier run`)
      .and.to.contain('migrate-resolve');
  });

  it('the Orm has no Migrator and listens for nothing: migrations are reachable only through resolveMigrationTool()', async () => {
    createTrackingTables();
    const listeners = DI.listenerCount('di.resolved.Orm');

    const { orm } = await migrateTestDatabase(tool);
    const booted = await app.resolve(Orm);

    expect(Object.keys(orm)).to.not.include('Migrator');
    expect(Object.keys(booted)).to.not.include('Migrator');
    expect(DI.listenerCount('di.resolved.Orm')).to.equal(listeners);
    expect(tool.listenerCount('di.resolved.Orm')).to.equal(0);
    expect(app.listenerCount('di.resolved.Orm')).to.equal(0);
  });
});

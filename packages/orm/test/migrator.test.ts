/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AsyncService, Autoinject, Class, DI, NewInstance } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';
import {
  AlterColumnQueryBuilder,
  AlterTableQueryBuilder,
  BooleanValueConverter,
  ColumnAlterationType,
  Connection,
  DropTableQueryBuilder,
  extractModelDescriptor,
  IColumnDescriptor,
  IMigrationRecord,
  MIGRATION_TABLE_NAME,
  Migration,
  MigrationTransactionMode,
  Model,
  ModelBase,
  Orm,
  OrmDriver,
  OrmException,
  OrmMigration,
  OrmMigrator,
  Primary,
  SelectQueryBuilder,
  TableExistsQueryBuilder,
  TableQueryBuilder,
} from '../src/index.js';
import { FakeSqliteDriver } from './misc.js';

const expect = chai.expect;

const CONNECTION = 'migrator';
const OTHER_CONNECTION = 'migrator-b';
const LOCK_TABLE = `${MIGRATION_TABLE_NAME}_lock`;

/** The fake database: table name to columns. tableInfo() answers null for any other table, as real drivers do. */
const TABLES = new Map<string, IColumnDescriptor[]>();

/** The tracking table's rows, as `records()` reads them. */
let RECORDS: IMigrationRecord[] = [];

/** Every builder the fake executed, in order. */
let EXECUTED: unknown[] = [];

let onStartup = true;
let strictSetting: boolean | undefined = false;

function column(name: string, type = 'INT', over: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
  return {
    Type: type,
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: type,
    Unsigned: false,
    Nullable: true,
    PrimaryKey: false,
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
    ...over,
  } as unknown as IColumnDescriptor;
}

function columnOf(c: any): IColumnDescriptor {
  return column(c.Name, String(c.Type).toUpperCase(), { PrimaryKey: !!c.PrimaryKey, Nullable: !c.NotNull });
}

function columnsOf(builder: TableQueryBuilder | AlterTableQueryBuilder): IColumnDescriptor[] {
  return builder.Columns.map(columnOf);
}

/** The table after an ALTER: dropped columns removed, renamed and modified ones replaced in place, added ones appended. */
function altered(existing: IColumnDescriptor[], builder: AlterTableQueryBuilder): IColumnDescriptor[] {
  let result = existing.filter((c) => !builder.DroppedColumns.includes(c.Name));

  (builder.Columns as AlterColumnQueryBuilder[]).forEach((c) => {
    const desc = columnOf(c);

    if (c.AlterType === ColumnAlterationType.Add) {
      result.push(desc);
    } else {
      result = result.map((r) => (r.Name === c.OldName ? desc : r));
    }
  });

  return result;
}

const now = new Date();

function applied(name: string): IMigrationRecord {
  return { Migration: name, CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Checksum: null, Batch: 1 };
}

// one instance per connection, as the dialect drivers are
@NewInstance()
class MigratorTestDriver extends FakeSqliteDriver {
  public async execute(b: any): Promise<any> {
    EXECUTED.push(b);

    if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
      return RECORDS;
    }

    if (b instanceof SelectQueryBuilder) {
      return [];
    }

    if (b instanceof TableExistsQueryBuilder) {
      return TABLES.has(b.Table) ? [{ 1: 1 }] : [];
    }

    if (b instanceof TableQueryBuilder) {
      TABLES.set(b.Table, columnsOf(b));
    } else if (b instanceof AlterTableQueryBuilder) {
      TABLES.set(b.Table, altered(TABLES.get(b.Table) ?? [], b));
    } else if (b instanceof DropTableQueryBuilder) {
      TABLES.delete(b.Table);
    }

    return [{ 1: 1 }];
  }

  /** Stands in for a dialect driver's raw entry point, so a migration can bypass the builders. */
  public async executeOnDb(_stmt: string): Promise<unknown> {
    return [];
  }

  /** Leaves `Converter` unset, as a driver may: a converter the Orm assigned on an earlier read must not survive. */
  public async tableInfo(table: string): Promise<IColumnDescriptor[]> {
    const columns = TABLES.get(table);
    return columns ? columns.map(({ Converter: _converter, ...c }) => ({ ...c }) as IColumnDescriptor) : (null as any);
  }
}

class MigratorTestConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    const migration = { OnStartup: onStartup, Transaction: { Mode: MigrationTransactionMode.None } };

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
        Connections: [
          { Driver: 'migrator-test-driver', Name: CONNECTION, Migration: migration },
          { Driver: 'migrator-test-driver', Name: OTHER_CONNECTION, Migration: migration },
        ],
      },
    };
  }
}

/** Declared per test: @Model registers globally and the columns a test reads into a descriptor must not leak. */
function defineModels() {
  @Connection(CONNECTION)
  @Model('mig_users')
  class MigratorTestUser extends ModelBase {
    @Primary()
    public Id: number;

    public Active: boolean;
  }

  @Connection(CONNECTION)
  @Model('mig_posts')
  class MigratorTestPost extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('mig_other')
  class MigratorTestOther extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(OTHER_CONNECTION)
  @Model('mig_b')
  class MigratorTestB extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { MigratorTestUser, MigratorTestPost, MigratorTestOther, MigratorTestB };
}

let models: ReturnType<typeof defineModels>;

/** A service built the way the ORM-backed stores are: it only injects the Orm. */
class MigratorTestUserStore extends AsyncService {
  @Autoinject(Orm)
  protected Orm: Orm;

  public async list(): Promise<unknown[]> {
    return await models.MigratorTestUser.all();
  }
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

/** The model tables `tableInfo()` was asked for, in call order. */
function modelTableReads(spy: sinon.SinonSpy): string[] {
  const tables = ['mig_users', 'mig_posts', 'mig_other', 'mig_b'];
  return spy.getCalls().map((c) => c.args[0] as string).filter((t) => tables.includes(t));
}

const TRACKING_COLUMNS = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'].map((n) => column(n, 'VARCHAR'));

describe('OrmMigrator', function () {
  this.timeout(10000);

  let preRegistered: unknown[] = [];

  beforeEach(() => {
    DI.clearCache();
    DI.register(MigratorTestConf).as(Configuration);
    DI.register(MigratorTestDriver).as('migrator-test-driver');

    TABLES.clear();
    TABLES.set(MIGRATION_TABLE_NAME, TRACKING_COLUMNS);
    TABLES.set(LOCK_TABLE, [column('Id'), column('AcquiredAt', 'DATETIME'), column('Owner', 'VARCHAR')]);
    TABLES.set('mig_posts', [column('Id', 'INT', { PrimaryKey: true }), column('Title', 'VARCHAR')]);
    TABLES.set('mig_other', [column('Id', 'INT', { PrimaryKey: true }), column('Note', 'VARCHAR')]);
    TABLES.set('mig_b', [column('Id', 'INT', { PrimaryKey: true })]);

    RECORDS = [];
    EXECUTED = [];
    onStartup = true;
    strictSetting = false;

    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
    models = defineModels();
  });

  afterEach(async () => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t as Class<unknown>);
      }
    }

    Object.values(models).forEach((m) => DI.unregister(m));
    DI.unregister(MigratorTestConf);
    DI.unregister(MigratorTestDriver);
    DI.clearCache();
    sinon.restore();
  });

  function createUsersMigration() {
    @Migration(CONNECTION)
    class MigratorTestCreateUsers_2026_10_21_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver) {
        await connection.schema().createTable('mig_users', (t) => {
          t.int('Id').primaryKey();
          t.string('Email');
          t.boolean('Active');
        });
      }

      public async down() {}
    }

    return MigratorTestCreateUsers_2026_10_21_00_00_00;
  }

  function alterMigration(table: string, alter: (t: AlterTableQueryBuilder) => void) {
    @Migration(CONNECTION)
    class MigratorTestAlter_2026_10_22_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver) {
        await connection.schema().alterTable(table, alter);
      }

      public async down() {}
    }

    return MigratorTestAlter_2026_10_22_00_00_00;
  }

  const columnNames = (model: Class<ModelBase>) => extractModelDescriptor(model)!.Columns.map((c) => c.Name);

  it('(i) a column a migration dropped leaves the model', async () => {
    alterMigration('mig_posts', (t) => t.dropColumn('Title'));

    await DI.resolve(Orm);
    expect(columnNames(models.MigratorTestPost)).to.include('Title');

    await DI.resolve(OrmMigrator);

    expect(columnNames(models.MigratorTestPost)).to.eql(['Id']);
  });

  it('(i) a column a migration renamed is known by its new name only', async () => {
    alterMigration('mig_posts', (t) => {
      t.string('Title').rename('Headline');
    });

    await DI.resolve(OrmMigrator);

    expect(columnNames(models.MigratorTestPost)).to.eql(['Id', 'Headline']);
  });

  it('(i) a column whose type a migration changed loses the converter its old type mapped to', async () => {
    TABLES.set('mig_users', [column('Id', 'INT', { PrimaryKey: true }), column('Active', 'BOOLEAN')]);
    alterMigration('mig_users', (t) => {
      t.string('Active').modify();
    });

    await DI.resolve(Orm);
    const before = extractModelDescriptor(models.MigratorTestUser)!.Columns.find((c) => c.Name === 'Active')!;
    expect(before.Converter).to.be.instanceOf(BooleanValueConverter);

    await DI.resolve(OrmMigrator);

    const after = extractModelDescriptor(models.MigratorTestUser)!.Columns.find((c) => c.Name === 'Active')!;
    expect(after.NativeType).to.equal('STRING');
    expect(after.Converter).to.not.be.instanceOf(BooleanValueConverter);
  });

  it('(a) resolving the Orm on an empty schema creates no table and applies nothing', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');

    await DI.resolve(Orm);

    expect(up.called, 'a migration ran inside the Orm resolve').to.be.false;
    expect(TABLES.has('mig_users')).to.be.false;
    expect(
      EXECUTED.some((b) => b instanceof SelectQueryBuilder && (b as SelectQueryBuilder).Table === MIGRATION_TABLE_NAME),
      'the Orm resolve read the tracking table',
    ).to.be.false;
    expect(EXECUTED.some((b) => b instanceof TableQueryBuilder)).to.be.false;
  });

  it('(b) resolving the migrator applies the pending migrations; the created tables model has columns and converters', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');

    const migrator = await DI.resolve(OrmMigrator);

    expect(up.calledOnce).to.be.true;
    expect(migrator.Runner, 'the runner is what migrate:up and the status commands use').to.not.be.undefined;

    const columns = extractModelDescriptor(models.MigratorTestUser)!.Columns;
    expect(columns.map((c) => c.Name)).to.include.members(['Id', 'Email', 'Active']);
    expect(columns.find((c) => c.Name === 'Active')!.Converter).to.be.instanceOf(BooleanValueConverter);
  });

  it('(c) re-reads the table info of the touched models only, and leaves the others intact', async () => {
    createUsersMigration();

    await DI.resolve(Orm);
    const otherColumns = extractModelDescriptor(models.MigratorTestOther)!.Columns;
    expect(otherColumns.map((c) => c.Name), 'read by the Orm resolve').to.include('Note');

    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await DI.resolve(OrmMigrator);

    expect(modelTableReads(tableInfo)).to.eql(['mig_users']);
    expect(extractModelDescriptor(models.MigratorTestOther)!.Columns.map((c) => c.Name)).to.include('Note');
    expect(extractModelDescriptor(models.MigratorTestOther)!.Driver).to.equal((await DI.resolve(Orm)).Connections.get(CONNECTION));
  });

  it('(c) a migration that runs raw schema SQL re-reads every model of its connection', async () => {
    @Migration(CONNECTION)
    class MigratorTestRaw_2026_10_21_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver) {
        await connection.schema().raw('ALTER TABLE mig_posts ADD COLUMN Body TEXT');
      }

      public async down() {}
    }

    void MigratorTestRaw_2026_10_21_00_00_00;

    await DI.resolve(Orm);
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await DI.resolve(OrmMigrator);

    expect(modelTableReads(tableInfo).sort()).to.eql(['mig_other', 'mig_posts', 'mig_users']);
  });

  it('(c) a migration that sends SQL straight to the driver re-reads every model of its connection', async () => {
    @Migration(CONNECTION)
    class MigratorTestDirect_2026_10_21_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver) {
        await (connection as MigratorTestDriver).executeOnDb('ALTER TABLE mig_posts ADD COLUMN Body TEXT');
      }

      public async down() {}
    }

    void MigratorTestDirect_2026_10_21_00_00_00;

    await DI.resolve(Orm);
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await DI.resolve(OrmMigrator);

    expect(modelTableReads(tableInfo).sort()).to.eql(['mig_other', 'mig_posts', 'mig_users']);
    expect(Object.prototype.hasOwnProperty.call((await DI.resolve(Orm)).Connections.get(CONNECTION), 'executeOnDb'), 'the raw-SQL detector must not outlive the migration').to.be.false;
  });

  it("(d) a migration's data() resolving a service that injects the Orm and querying a model completes", async () => {
    let listed: unknown[] | undefined;

    @Migration(CONNECTION)
    class MigratorTestSeed_2026_10_21_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver) {
        await connection.schema().createTable('mig_users', (t) => {
          t.int('Id').primaryKey();
          t.boolean('Active');
        });
      }

      public async down() {}

      public async data() {
        const store = await DI.resolve(MigratorTestUserStore);
        listed = await store.list();
      }
    }

    void MigratorTestSeed_2026_10_21_00_00_00;

    await within(3000, Promise.resolve(DI.resolve(OrmMigrator)));

    expect(listed).to.eql([]);
  });

  it("(e) a migration's up() queries a model on its gated connection", async () => {
    let listed: unknown[] | undefined;

    @Migration(CONNECTION)
    class MigratorTestUpQueries_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        listed = await models.MigratorTestPost.all();
      }

      public async down() {}
    }

    void MigratorTestUpQueries_2026_10_21_00_00_00;

    await DI.resolve(OrmMigrator);

    expect(listed).to.eql([]);
  });

  it("(e) a migration's up() resolving a service that injects the Orm does not hang", async () => {
    let store: MigratorTestUserStore | undefined;

    @Migration(CONNECTION)
    class MigratorTestUpResolves_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        store = await DI.resolve(MigratorTestUserStore);
      }

      public async down() {}
    }

    void MigratorTestUpResolves_2026_10_21_00_00_00;

    await within(3000, Promise.resolve(DI.resolve(OrmMigrator)));

    expect(store).to.be.instanceOf(MigratorTestUserStore);
  });

  it('(f) a migration that throws rejects the migrator; the data() of the ones applied before it does not run', async () => {
    const Create = createUsersMigration();
    const seeded = sinon.stub(Create.prototype, 'data').resolves();
    const boom = new Error('boom');

    @Migration(CONNECTION)
    class MigratorTestThrows_2026_10_22_00_00_00 extends OrmMigration {
      public async up() {
        throw boom;
      }

      public async down() {}
    }

    void MigratorTestThrows_2026_10_22_00_00_00;

    const err = await rejection(Promise.resolve(DI.resolve(OrmMigrator)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('MigratorTestThrows_2026_10_22_00_00_00').and.to.contain('boom');
    expect((err as OrmException).inner).to.equal(boom);
    expect(seeded.called, 'runDataPhase runs only after the whole pass succeeded').to.be.false;
  });

  it('(f) every data() hook runs and the failures are reported together', async () => {
    const Create = createUsersMigration();
    sinon.stub(Create.prototype, 'data').rejects(new Error('seed 1 failed'));

    @Migration(CONNECTION)
    class MigratorTestSecondSeed_2026_10_22_00_00_00 extends OrmMigration {
      public async up() {}
      public async down() {}
    }

    const second = sinon.stub(MigratorTestSecondSeed_2026_10_22_00_00_00.prototype, 'data').callsFake(() => Promise.reject('bare string'));

    const err = await rejection(Promise.resolve(DI.resolve(OrmMigrator)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('seed 1 failed').and.to.contain('bare string').and.not.to.contain('undefined');
    expect(second.calledOnce).to.be.true;
  });

  it('(g) a model query on an OnStartup connection throws until the migrator resolved', async () => {
    await DI.resolve(Orm);

    expect(() => models.MigratorTestPost.all()).to.throw(OrmException, 'connection migrator migrates on startup; resolve OrmMigrator before using it');

    await DI.resolve(OrmMigrator);

    expect(await models.MigratorTestPost.all()).to.eql([]);
  });

  it('(g) a model query outside the migrator is refused while its pass runs', async () => {
    let started!: () => void;
    let release!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const held = new Promise<void>((r) => (release = r));

    @Migration(CONNECTION)
    class MigratorTestHeld_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        started();
        await held;
      }

      public async down() {}
    }

    void MigratorTestHeld_2026_10_21_00_00_00;

    const resolving = Promise.resolve(DI.resolve(OrmMigrator));
    await within(3000, running);

    expect(() => models.MigratorTestPost.all()).to.throw(OrmException, 'connection migrator migrates on startup; resolve OrmMigrator before using it');

    release();
    await resolving;

    expect(await models.MigratorTestPost.all()).to.eql([]);
  });

  it('(g) the gate stays closed when the migrator pass fails', async () => {
    @Migration(CONNECTION)
    class MigratorTestFails_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        throw new Error('boom');
      }

      public async down() {}
    }

    void MigratorTestFails_2026_10_21_00_00_00;

    expect(await rejection(Promise.resolve(DI.resolve(OrmMigrator)))).to.be.instanceOf(OrmException);

    expect(() => models.MigratorTestPost.all()).to.throw(OrmException, 'connection migrator migrates on startup; resolve OrmMigrator before using it');
  });

  it('(g) a connection with OnStartup off is not gated', async () => {
    onStartup = false;

    await DI.resolve(Orm);

    expect(await models.MigratorTestPost.all()).to.eql([]);
  });

  it('(h) on an already migrated database the migrator applies nothing and reads no table info', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');
    TABLES.set('mig_users', [column('Id', 'INT', { PrimaryKey: true })]);
    RECORDS = [applied(Create.name)];

    await DI.resolve(Orm);
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await DI.resolve(OrmMigrator);

    expect(up.called).to.be.false;
    expect(modelTableReads(tableInfo)).to.eql([]);
  });

  it('the Orm resolve is lenient about missing tables; the migrator fails with db.StrictTableCheck on', async () => {
    strictSetting = true;
    TABLES.delete('mig_other');
    createUsersMigration();

    await DI.resolve(Orm);
    const err = await rejection(Promise.resolve(DI.resolve(OrmMigrator)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model MigratorTestOther: table mig_other on connection migrator. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('MigrateOnStartup: false resolves without a pass and opens the gate; migrate() applies and seeds', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');
    const seeded = sinon.stub(Create.prototype, 'data').resolves();

    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);

    expect(up.called).to.be.false;
    expect(await models.MigratorTestPost.all()).to.eql([]);

    const executed = await migrator.migrate();

    expect(executed.map((m) => m.constructor.name)).to.eql([Create.name]);
    expect(up.calledOnce).to.be.true;
    expect(seeded.calledOnce).to.be.true;
    expect(extractModelDescriptor(models.MigratorTestUser)!.Columns.map((c) => c.Name)).to.include('Active');
  });

  it('migrate({ fake: true }) records the migrations and neither runs nor seeds them', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');
    const seeded = sinon.stub(Create.prototype, 'data').resolves();

    const migrator = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
    const executed = await migrator.migrate({ fake: true });

    expect(executed).to.have.length(1);
    expect(up.called).to.be.false;
    expect(seeded.called, 'a faked migration never ran up(), so its seed has nothing to seed into').to.be.false;
  });
});

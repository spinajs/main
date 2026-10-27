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
  ormConnection,
  Primary,
  resolveMigrationTool,
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
  };
}

function columnOf(c: { Name: string; Type: string; PrimaryKey?: boolean; NotNull?: boolean }): IColumnDescriptor {
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- a missing table answers null like a real driver, which the abstract signature does not declare
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
    new Promise<T>((_resolve, reject) => {
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
        DI.unregister(t);
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

    const migrator = await resolveMigrationTool();
    expect(columnNames(models.MigratorTestPost)).to.include('Title');

    await migrator.migrate();

    expect(columnNames(models.MigratorTestPost)).to.eql(['Id']);
  });

  it('(i) a column a migration renamed is known by its new name only', async () => {
    alterMigration('mig_posts', (t) => {
      t.string('Title').rename('Headline');
    });

    await DI.resolve(Orm);

    expect(columnNames(models.MigratorTestPost)).to.eql(['Id', 'Headline']);
  });

  it('(i) a column whose type a migration changed loses the converter its old type mapped to', async () => {
    TABLES.set('mig_users', [column('Id', 'INT', { PrimaryKey: true }), column('Active', 'BOOLEAN')]);
    alterMigration('mig_users', (t) => {
      t.string('Active').modify();
    });

    const migrator = await resolveMigrationTool();
    const before = extractModelDescriptor(models.MigratorTestUser)!.Columns.find((c) => c.Name === 'Active')!;
    expect(before.Converter).to.be.instanceOf(BooleanValueConverter);

    await migrator.migrate();

    const after = extractModelDescriptor(models.MigratorTestUser)!.Columns.find((c) => c.Name === 'Active')!;
    expect(after.NativeType).to.equal('STRING');
    expect(after.Converter).to.not.be.instanceOf(BooleanValueConverter);
  });

  it('(c) re-reads the table info of the touched models only, and leaves the others intact', async () => {
    createUsersMigration();

    const migrator = await resolveMigrationTool();
    const otherColumns = extractModelDescriptor(models.MigratorTestOther)!.Columns;
    expect(otherColumns.map((c) => c.Name), 'read by the Orm resolve').to.include('Note');

    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await migrator.migrate();

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

    const migrator = await resolveMigrationTool();
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await migrator.migrate();

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

    const migrator = await resolveMigrationTool();
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await migrator.migrate();

    expect(modelTableReads(tableInfo).sort()).to.eql(['mig_other', 'mig_posts', 'mig_users']);
    expect(Object.prototype.hasOwnProperty.call((await DI.resolve(Orm)).Connections.get(CONNECTION), 'executeOnDb'), 'the raw-SQL detector must not outlive the migration').to.be.false;
  });

  it('(c) a table created through another driver instance of the connection re-reads its model', async () => {
    @Migration(CONNECTION)
    class MigratorTestTwin_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        const twin = await DI.resolve<OrmDriver>('migrator-test-driver', [{ Driver: 'migrator-test-driver', Name: CONNECTION }]);
        await twin.schema().createTable('mig_users', (t) => {
          t.int('Id').primaryKey();
          t.string('Email');
        });
      }

      public async down() {}
    }

    void MigratorTestTwin_2026_10_21_00_00_00;

    await DI.resolve(Orm);

    expect(columnNames(models.MigratorTestUser)).to.include('Email');
  });

  it('(c) SQL a migration sends straight to another connection re-reads every model of that connection', async () => {
    @Migration(CONNECTION)
    class MigratorTestDirectOther_2026_10_21_00_00_00 extends OrmMigration {
      public async up() {
        await (ormConnection(OTHER_CONNECTION) as MigratorTestDriver).executeOnDb('ALTER TABLE mig_b ADD COLUMN Extra TEXT');
        TABLES.set('mig_b', [...TABLES.get('mig_b')!, column('Extra', 'TEXT')]);
      }

      public async down() {}
    }

    void MigratorTestDirectOther_2026_10_21_00_00_00;

    const migrator = await resolveMigrationTool();
    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await migrator.migrate();

    expect(modelTableReads(tableInfo)).to.include('mig_b');
    expect(columnNames(models.MigratorTestB)).to.include('Extra');
  });

  it('the Orm resolve fails with db.StrictTableCheck on when a connection without Migration.OnStartup misses a table', async () => {
    onStartup = false;
    strictSetting = true;
    TABLES.set('mig_users', [column('Id', 'INT', { PrimaryKey: true })]);
    TABLES.delete('mig_other');

    const err = await rejection(Promise.resolve(DI.resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model MigratorTestOther: table mig_other on connection migrator. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('a migrator with MigrateOnStartup: false resolves its Orm without the table check, as a migration tool runs before the tables exist', async () => {
    onStartup = false;
    strictSetting = true;
    TABLES.delete('mig_other');

    const migrator = await resolveMigrationTool();

    expect(migrator.Runner).to.not.be.undefined;
  });

  it('MigrateOnStartup: false applies nothing on the way in; migrate() applies and seeds', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');
    const seeded = sinon.stub(Create.prototype, 'data').resolves();

    const migrator = await resolveMigrationTool();

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

    const migrator = await resolveMigrationTool();
    const executed = await migrator.migrate({ fake: true });

    expect(executed).to.have.length(1);
    expect(up.called).to.be.false;
    expect(seeded.called, 'a faked migration never ran up(), so its seed has nothing to seed into').to.be.false;
  });

  it('resolving the Orm applies the pending migrations before it reads table info', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');

    const orm = await DI.resolve(Orm);

    expect(up.calledOnce).to.be.true;
    expect(columnNames(models.MigratorTestUser)).to.include.members(['Id', 'Email', 'Active']);
    expect(extractModelDescriptor(models.MigratorTestUser)!.Columns.find((c) => c.Name === 'Active')!.Converter).to.be.instanceOf(BooleanValueConverter);
    expect(orm.Migrator).to.equal(DI.get(OrmMigrator));
    expect(orm.Migrator.Runner).to.not.be.undefined;
  });

  it('resolving the Orm applies nothing on a connection with Migration.OnStartup off', async () => {
    onStartup = false;
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');

    await DI.resolve(Orm);

    expect(up.called).to.be.false;
    expect(TABLES.has('mig_users')).to.be.false;
  });

  it('data() runs once the Orm is cached, and ready() settles after it', async () => {
    let cachedInSeed: unknown;
    const Create = createUsersMigration();
    const seeded = sinon.stub(Create.prototype, 'data').callsFake(async () => {
      cachedInSeed = DI.get(Orm);
    });

    const orm = await DI.resolve(Orm);
    await orm.Migrator.ready();

    expect(seeded.calledOnce).to.be.true;
    expect(cachedInSeed).to.equal(orm);
  });

  it("a migration's data() resolving a service that injects the Orm and querying a model completes", async () => {
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

    const orm = await within(3000, Promise.resolve(DI.resolve(Orm)));
    await within(3000, orm.Migrator.ready());

    expect(listed).to.eql([]);
  });

  it('a migration that throws rejects the Orm resolve, caches no Orm, closes its connections and seeds nothing', async () => {
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

    const disconnect = sinon.spy(MigratorTestDriver.prototype, 'disconnect');
    const err = await rejection(Promise.resolve(DI.resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('MigratorTestThrows_2026_10_22_00_00_00').and.to.contain('boom');
    expect((err as OrmException).inner).to.equal(boom);
    expect(DI.get(Orm)).to.be.undefined;
    expect(disconnect.called).to.be.true;
    expect(seeded.called).to.be.false;
  });

  it('every data() hook runs; the failures reject ready() together and leave the Orm resolved', async () => {
    const Create = createUsersMigration();
    sinon.stub(Create.prototype, 'data').rejects(new Error('seed 1 failed'));

    @Migration(CONNECTION)
    class MigratorTestSecondSeed_2026_10_22_00_00_00 extends OrmMigration {
      public async up() {}
      public async down() {}
    }

    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the test is about a seed rejecting with a non-Error
    const second = sinon.stub(MigratorTestSecondSeed_2026_10_22_00_00_00.prototype, 'data').callsFake(() => Promise.reject('bare string'));

    const orm = await DI.resolve(Orm);
    const err = await rejection(orm.Migrator.ready());

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.contain('seed 1 failed').and.to.contain('bare string').and.not.to.contain('undefined');
    expect(second.calledOnce).to.be.true;
    expect(DI.get(Orm)).to.equal(orm);
  });

  it('(h) on an already migrated database the boot applies nothing and reads each model once', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');
    TABLES.set('mig_users', [column('Id', 'INT', { PrimaryKey: true })]);
    RECORDS = [applied(Create.name)];

    const tableInfo = sinon.spy(MigratorTestDriver.prototype, 'tableInfo');
    await DI.resolve(Orm);

    expect(up.called).to.be.false;
    expect(modelTableReads(tableInfo).sort()).to.eql(['mig_b', 'mig_other', 'mig_posts', 'mig_users']);
  });

  it('with db.StrictTableCheck on, the Orm resolve fails on a table still missing after its migrations', async () => {
    strictSetting = true;
    TABLES.delete('mig_other');
    createUsersMigration();

    const err = await rejection(Promise.resolve(DI.resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model MigratorTestOther: table mig_other on connection migrator. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('a migrator resolved with MigrateOnStartup: false before the Orm makes it apply nothing', async () => {
    const Create = createUsersMigration();
    const up = sinon.spy(Create.prototype, 'up');

    const migrator = await resolveMigrationTool();

    expect(up.called).to.be.false;
    expect((await DI.resolve(Orm)).Migrator).to.equal(migrator);
  });

  it('the next Orm, after only the Orm was uncached, reuses the cached migrator bound to itself', async () => {
    const first = await DI.resolve(Orm);
    DI.uncache(Orm);
    const second = await DI.resolve(Orm);

    expect(second).to.not.equal(first);
    expect(second.Migrator).to.equal(first.Migrator);
    expect((second.Migrator.Runner as unknown as { orm: Orm }).orm).to.equal(second);
  });

  it('resolving the Orm and the migrator together does not hang', async () => {
    const [orm, migrator] = await within(3000, Promise.all([DI.resolve(Orm), DI.resolve(OrmMigrator)]));

    expect(orm.Migrator).to.equal(migrator);
  });
});

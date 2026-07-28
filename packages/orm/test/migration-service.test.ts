import { Configuration } from '@spinajs/configuration';
import { DI, Bootstrapper, Class } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { createHash } from 'node:crypto';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, ConnectionConf, FakeTableQueryCompiler, FakeColumnQueryCompiler, FakeTableExistsCompiler, FakeDefaultValueBuilder, TEST_TABLE_INFO } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, TableExistsCompiler, DefaultValueBuilder, DefaultMigrationService, MIGRATION_TABLE_NAME, migrationChecksum, OrmMigration, MigrationTransactionMode, IMigrationRecord, IMigrationUnit, OrmException } from '../src/index.js';
import { TableQueryBuilder, AlterTableQueryBuilder, RawSchemaQueryBuilder, SelectQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

const expect = chai.expect;

async function makeDriver(): Promise<FakeSqliteDriver> {
  // resolve driver exactly like Orm does, with the sqlite connection options from ConnectionConf
  const conf = await DI.resolve(Configuration);
  const opts = conf.get<any[]>('db.Connections').find((c: any) => c.Name === 'sqlite');
  return (await DI.resolve<OrmDriver>('sqlite', [opts])) as FakeSqliteDriver;
}

function registerFakes() {
  DI.register(ConnectionConf).as(Configuration);
  DI.register(FakeSqliteDriver).as('sqlite');
  DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
  DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
  DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
  DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
  DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
  DI.register(FakeColumnQueryCompiler).as(ColumnQueryCompiler);
  DI.register(FakeTableExistsCompiler).as(TableExistsCompiler);
  // dialect packages own the concrete DefaultValueBuilder; without one, `default()` resolves
  // the abstract class and dies on `value()`
  DI.register(FakeDefaultValueBuilder).as(DefaultValueBuilder);
}

async function bootstrapAll() {
  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) await b.bootstrap();
}

describe('DefaultMigrationService storage', () => {
  before(() => {
    registerFakes();
  });

  beforeEach(async () => {
    await bootstrapAll();
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
  });

  it('creates tracking and lock tables when absent', async () => {
    const driver = await makeDriver();
    // tableExists compiles through FakeTableExistsCompiler; empty result = table absent
    const exec = sinon.stub(FakeSqliteDriver.prototype, 'execute').resolves([]);
    const svc = new DefaultMigrationService(driver);

    await svc.ensureStorage();

    const created = exec.getCalls().filter((c) => c.args[0] instanceof TableQueryBuilder);
    expect(created).to.have.length(2); // spinajs_migration + spinajs_migration_lock
    expect(created.map((c) => (c.args[0] as TableQueryBuilder).Table)).to.eql([MIGRATION_TABLE_NAME, `${MIGRATION_TABLE_NAME}_lock`]);
  });

  it('upgrades legacy 2-column table and backfills', async () => {
    const driver = await makeDriver();
    // legacy shape: only Migration + CreatedAt known to tableInfo
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = [{ Name: 'Migration' }, { Name: 'CreatedAt' }] as any;
    // tableExists → any non-empty row = exists
    const exec = sinon.stub(FakeSqliteDriver.prototype, 'execute').resolves([{ 1: 1 }]);
    const svc = new DefaultMigrationService(driver);

    await svc.ensureStorage();

    const alters = exec.getCalls().filter((c) => c.args[0] instanceof AlterTableQueryBuilder);
    // StartedAt, FinishedAt, RolledBackAt, Logs, Checksum, Batch = 6 added columns
    expect(alters.length).to.be.gte(1);
    expect(alters.flatMap((c) => (c.args[0] as AlterTableQueryBuilder).Columns.map((col) => col.Name))).to.eql(['StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch']);

    const raws = exec.getCalls().filter((c) => c.args[0] instanceof RawSchemaQueryBuilder);
    expect(raws.length).to.be.gte(1); // backfill UPDATE ran

    // an already-upgraded table is left alone
    expect(exec.getCalls().filter((c) => c.args[0] instanceof TableQueryBuilder)).to.have.length(0);
  });

  it('applied() returns only finished, not-rolled-back rows', async () => {
    const driver = await makeDriver();
    const now = new Date();
    sinon.stub(FakeSqliteDriver.prototype, 'execute').resolves([
      { Migration: 'A_2021_01_01_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Checksum: null, Batch: 1 },
      { Migration: 'B_2021_01_02_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: 'boom', Checksum: null, Batch: 1 },
      { Migration: 'C_2021_01_03_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: now, Logs: null, Checksum: null, Batch: 2 },
    ]);
    const svc = new DefaultMigrationService(driver);

    const rows = await svc.applied();
    expect(rows.map((r) => r.Migration)).to.eql(['A_2021_01_01_00_00_00']);
  });

  it('migrationChecksum is stable sha256 hex of class source', () => {
    class X_2021_01_01_00_00_00 extends OrmMigration {
      public async up() {}
      public async down() {}
    }
    const a = migrationChecksum(X_2021_01_01_00_00_00);
    const b = migrationChecksum(X_2021_01_01_00_00_00);
    expect(a).to.eq(b);
    expect(a).to.match(/^[0-9a-f]{64}$/);
    expect(a).to.eq(createHash('sha256').update(X_2021_01_01_00_00_00.toString()).digest('hex'));
  });
});

class MigA_2021_01_01_00_00_00 extends OrmMigration {
  public async up(_c: OrmDriver) {}
  public async down(_c: OrmDriver) {}
}

class MigB_2021_01_02_00_00_00 extends OrmMigration {
  public async up(_c: OrmDriver) {}
  public async down(_c: OrmDriver) {}
}

describe('DefaultMigrationService up', () => {
  const now = new Date();

  const row = (over: Partial<IMigrationRecord>): IMigrationRecord => ({
    Migration: 'X',
    CreatedAt: now,
    StartedAt: now,
    FinishedAt: now,
    RolledBackAt: null,
    Logs: null,
    Checksum: null,
    Batch: 1,
    ...over,
  });

  const unit = (t: Class<OrmMigration>): IMigrationUnit => ({
    name: t.name,
    created: DateTime.fromFormat(t.name.match(/_(\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2})$/)![1], 'yyyy_MM_dd_HH_mm_ss'),
    type: t,
  });

  /**
   * Stubs driver execution so a select on the tracking table answers with `rows` and every
   * other statement ( tableExists probes, DDL, inserts, updates ) reports success. The
   * returned stub carries the executed builders, which is what the assertions read.
   */
  function stubDb(rows: IMigrationRecord[]) {
    return sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return rows;
      }
      // one row back = tableExists true, and a harmless result for everything else
      return [{ 1: 1 }];
    });
  }

  before(() => {
    registerFakes();
  });

  beforeEach(async () => {
    await bootstrapAll();

    // tracking table already in its current shape, so ensureStorage() adds nothing to the
    // executed-builder list these tests assert on
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'].map((Name) => ({ Name })) as any;
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
  });

  it('runs pending migrations, skips applied, stamps next batch', async () => {
    const driver = await makeDriver();
    const exec = stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 3 })]);
    const upA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'up');
    const upB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'up');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

    expect(upA.called).to.be.false;
    expect(upB.calledOnce).to.be.true;
    expect(executed).to.have.length(1);
    expect(executed[0]).to.be.instanceOf(MigB_2021_01_02_00_00_00);

    const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder);
    expect(inserts).to.have.length(1);
    expect((inserts[0].args[0] as InsertQueryBuilder).getColumnValues('Migration')).to.eql(['MigB_2021_01_02_00_00_00']);

    // batch lands on the finishing UPDATE: max(3) + 1
    const updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
    const finish = updates.map((c) => (c.args[0] as UpdateQueryBuilder<unknown>).Value as any).find((v) => v.FinishedAt);
    expect(finish).to.not.be.undefined;
    expect(finish.Batch).to.eq(4);
    expect(finish.Checksum).to.eq(migrationChecksum(MigB_2021_01_02_00_00_00));
  });

  it('fake: true records without executing', async () => {
    const driver = await makeDriver();
    const exec = stubDb([]);
    const upB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'up');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigB_2021_01_02_00_00_00)], { fake: true });

    expect(upB.called).to.be.false;
    expect(executed).to.have.length(1);

    const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder);
    expect(inserts).to.have.length(1);

    const insert = inserts[0].args[0] as InsertQueryBuilder;
    expect(insert.getColumnValues('Migration')).to.eql(['MigB_2021_01_02_00_00_00']);
    expect(insert.getColumnValues('Checksum')).to.eql([migrationChecksum(MigB_2021_01_02_00_00_00)]);
    expect(insert.getColumnValues('Batch')).to.eql([1]);
    // recorded as finished, not merely started
    expect(insert.getColumnValues('FinishedAt')[0]).to.be.instanceOf(Date);
  });

  it('failed row blocks the run with resolve hint', async () => {
    const driver = await makeDriver();
    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'kaboom' })]);
    const upB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'up');
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigB_2021_01_02_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('MigA_2021_01_01_00_00_00');
      expect(e.message).to.contain('resolve');
    }

    expect(upB.called).to.be.false;
  });

  it('failing up() writes Logs and rethrows', async () => {
    const driver = await makeDriver();
    const exec = stubDb([]);
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('ddl exploded'));
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('ddl exploded');
    }

    // failure recorded via UpdateQueryBuilder carrying Logs
    const updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
    expect(updates.some((c) => ((c.args[0] as UpdateQueryBuilder<unknown>).Value as any)?.Logs)).to.be.true;
    // and nothing was stamped as finished
    expect(updates.some((c) => ((c.args[0] as UpdateQueryBuilder<unknown>).Value as any)?.FinishedAt)).to.be.false;
  });

  it('PerRun wraps whole run in one transaction, transaction=false runs outside', async () => {
    const driver = await makeDriver();
    // replaced rather than mutated in place: Options.Migration is the object the Configuration
    // handed out, and mutating it would leak the mode into every later resolve
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerRun } };
    stubDb([]);

    class NoTx_2021_01_03_00_00_00 extends OrmMigration {
      public transaction = false;
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    // a transaction count alone cannot tell "A+B wrapped, NoTx outside" from "all three
    // wrapped" - so record whether each up() actually saw an ambient transaction
    const inTransaction: Record<string, boolean> = {};
    const track = (name: string) => async (c: OrmDriver) => {
      inTransaction[name] = c.CurrentTransaction !== undefined;
    };
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').callsFake(track('MigA'));
    sinon.stub(MigB_2021_01_02_00_00_00.prototype, 'up').callsFake(track('MigB'));
    sinon.stub(NoTx_2021_01_03_00_00_00.prototype, 'up').callsFake(track('NoTx'));

    const tr = sinon.spy(FakeSqliteDriver.prototype, 'transaction');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00), unit(NoTx_2021_01_03_00_00_00)]);

    expect(tr.callCount).to.eq(1); // A+B in one tx; NoTx outside
    expect(inTransaction).to.eql({ MigA: true, MigB: true, NoTx: false });
    expect(executed.map((e) => e.constructor.name)).to.eql(['MigA_2021_01_01_00_00_00', 'MigB_2021_01_02_00_00_00', 'NoTx_2021_01_03_00_00_00']);
  });

  it('PerRun writes the failure row after the transaction rolled back', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerRun } };

    // a Logs write issued inside the failing transaction would be rolled back with everything
    // else, so record whether a transaction was in scope when each statement went out
    const seen: Array<{ logs: boolean; inTransaction: boolean }> = [];
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return [];
      }
      seen.push({ logs: b instanceof UpdateQueryBuilder && !!(b.Value as any)?.Logs, inTransaction: driver.CurrentTransaction !== undefined });
      return [{ 1: 1 }];
    });
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('ddl exploded'));
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('ddl exploded');
    }

    const failureWrite = seen.find((s) => s.logs);
    expect(failureWrite, 'expected a failure row').to.not.be.undefined;
    expect(failureWrite!.inTransaction, 'failure row must be written outside the rolled-back transaction').to.be.false;
  });

  it('PerMigration wraps each migration in its own transaction, transaction=false runs outside', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerMigration } };
    stubDb([]);

    class NoTxPerMig_2021_01_03_00_00_00 extends OrmMigration {
      public transaction = false;
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const inTransaction: Record<string, boolean> = {};
    const track = (name: string) => async (c: OrmDriver) => {
      inTransaction[name] = c.CurrentTransaction !== undefined;
    };
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').callsFake(track('MigA'));
    sinon.stub(MigB_2021_01_02_00_00_00.prototype, 'up').callsFake(track('MigB'));
    sinon.stub(NoTxPerMig_2021_01_03_00_00_00.prototype, 'up').callsFake(track('NoTx'));

    const tr = sinon.spy(FakeSqliteDriver.prototype, 'transaction');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00), unit(NoTxPerMig_2021_01_03_00_00_00)]);

    // one transaction per wrapped migration - 1 would mean PerRun's shared transaction, 3 would
    // mean the opt-out was ignored
    expect(tr.callCount).to.eq(2);
    expect(inTransaction).to.eql({ MigA: true, MigB: true, NoTx: false });
    expect(executed.map((e) => e.constructor.name)).to.eql(['MigA_2021_01_01_00_00_00', 'MigB_2021_01_02_00_00_00', 'NoTxPerMig_2021_01_03_00_00_00']);
  });

  it('a rolled-back migration whose retry fails is left blocking the next run', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerMigration } };

    // applied once and later rolled back, so it is pending again while still carrying the old
    // FinishedAt / RolledBackAt timestamps
    const table = [row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: now, RolledBackAt: now, Batch: 2 })];
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return table.map((r) => ({ ...r }));
      }
      // writes issued inside the failing transaction vanish with it - that is what a rollback
      // does, and it is exactly how the reset upsertStart() wrote gets lost. Only one row lives
      // in this table, so the where clause needs no modelling.
      if (b instanceof UpdateQueryBuilder && b.Table === MIGRATION_TABLE_NAME && driver.CurrentTransaction === undefined) {
        Object.assign(table[0], b.Value as any);
      }
      return [{ 1: 1 }];
    });
    const upA = sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('ddl exploded'));
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('ddl exploded');
    }

    upA.resetHistory();

    // the half-applied migration must now block every later run instead of quietly retrying
    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('the half-applied migration should have blocked the run');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('MigA_2021_01_01_00_00_00');
      expect(e.message).to.contain('resolve');
    }

    expect(upA.called, 'a blocked run must not re-run the migration').to.be.false;

    // because the recorded state is the blocking one: FinishedAt NULL *and* Logs set
    expect(table[0].FinishedAt, 'the failure row must not keep the earlier attempt FinishedAt').to.be.null;
    expect(table[0].Logs).to.contain('ddl exploded');
  });

  it('warns when the recorded checksum no longer matches the migration source', async () => {
    const driver = await makeDriver();
    // rolled back, so still pending - and the stored checksum is not the current one
    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', RolledBackAt: now, Checksum: 'stale-checksum' })]);
    const svc = new DefaultMigrationService(driver);
    const warn = sinon.spy((svc as any).Log, 'warn');

    await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    const drift = warn.getCalls().find((c) => String(c.args[0]).includes('MigA_2021_01_01_00_00_00'));
    expect(drift, 'expected a checksum drift warning').to.not.be.undefined;
    expect(String(drift!.args[0])).to.contain('checksum');
  });
});

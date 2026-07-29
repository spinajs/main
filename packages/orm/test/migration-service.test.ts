import { Configuration } from '@spinajs/configuration';
import { DI, Bootstrapper, Class } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { createHash } from 'node:crypto';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, ConnectionConf, FakeTableQueryCompiler, FakeColumnQueryCompiler, FakeTableExistsCompiler, FakeDefaultValueBuilder, TEST_TABLE_INFO } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, TableExistsCompiler, DefaultValueBuilder, DefaultMigrationService, MIGRATION_TABLE_NAME, MIGRATION_LOCK_MAX_STEALS, migrationChecksum, OrmMigration, MigrationTransactionMode, IMigrationRecord, IMigrationUnit, OrmException } from '../src/index.js';
import { TableQueryBuilder, AlterTableQueryBuilder, RawSchemaQueryBuilder, SelectQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder, DeleteQueryBuilder, TableExistsQueryBuilder } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

const expect = chai.expect;

const LOCK_TABLE = `${MIGRATION_TABLE_NAME}_lock`;

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

  it('tolerates a table another process created between the probe and the CREATE', async () => {
    const driver = await makeDriver();

    // The lock table cannot guard its own creation, so two processes booting together both see
    // "absent" and both reach the CREATE. Here every table is absent on its first probe and
    // present on the next one - the loser's view of that race.
    const probes: Record<string, number> = {};
    const attempted: string[] = [];
    const exec = sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof TableExistsQueryBuilder) {
        probes[b.Table] = (probes[b.Table] ?? 0) + 1;
        return probes[b.Table] === 1 ? [] : [{ 1: 1 }];
      }
      if (b instanceof TableQueryBuilder) {
        attempted.push(b.Table);
        throw new Error(`table ${b.Table} already exists`);
      }
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);

    await svc.ensureStorage(); // a lost race is not an error

    expect(attempted, 'both tables must still be attempted').to.eql([MIGRATION_TABLE_NAME, LOCK_TABLE]);
    // probed once before the CREATE and once after it failed - the re-check is what proves the
    // failure was a lost race rather than a broken CREATE
    expect(probes[MIGRATION_TABLE_NAME]).to.eq(2);
    expect(probes[LOCK_TABLE]).to.eq(2);

    // a table that appeared inside that window was created by a peer running this same DDL, so
    // it already carries the current shape - re-running the legacy upgrade against it would try
    // to add columns that are all there
    expect(exec.getCalls().filter((c) => c.args[0] instanceof AlterTableQueryBuilder), 'a lost race must not fall into the legacy upgrade path').to.have.length(0);
  });

  it('does not swallow a CREATE that really failed', async () => {
    const driver = await makeDriver();
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      // the table stays absent, so nothing excuses the failure
      if (b instanceof TableExistsQueryBuilder) return [];
      if (b instanceof TableQueryBuilder) throw new Error('disk full');
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.ensureStorage();
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('disk full');
      expect(e.message).to.contain(MIGRATION_TABLE_NAME);
    }
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

describe('DefaultMigrationService up', () => {
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

    // scoped to the tracking table - the run also writes the lock row
    const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === MIGRATION_TABLE_NAME);
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

    // scoped to the tracking table - the run also writes the lock row
    const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === MIGRATION_TABLE_NAME);
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

describe('DefaultMigrationService down/resolve/status', () => {
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

  it('down() reverses only the last batch, in reverse order', async () => {
    const driver = await makeDriver();
    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }), row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 2 })]);
    const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
    const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

    expect(dA.called).to.be.false;
    expect(dB.calledOnce).to.be.true;
    expect(executed).to.have.length(1);
    expect(executed[0]).to.be.instanceOf(MigB_2021_01_02_00_00_00);
  });

  it('down({all:true}) reverses everything, newest first', async () => {
    const driver = await makeDriver();
    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }), row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 2 })]);
    const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
    const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)], { all: true });

    expect(dB.calledBefore(dA)).to.be.true;
    expect(dA.calledOnce).to.be.true;
    expect(executed.map((e) => e.constructor.name)).to.eql(['MigB_2021_01_02_00_00_00', 'MigA_2021_01_01_00_00_00']);
  });

  it('down({fake:true}) removes records without executing', async () => {
    const driver = await makeDriver();
    const exec = stubDb([row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 })]);
    const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);

    await svc.down([unit(MigB_2021_01_02_00_00_00)], { fake: true });

    expect(dB.called).to.be.false;
    expect(exec.getCalls().some((c) => c.args[0] instanceof DeleteQueryBuilder)).to.be.true;
  });

  it('down() under PerRun wraps the rollback in one transaction, transaction=false runs outside', async () => {
    const driver = await makeDriver();
    // replaced rather than mutated in place: Options.Migration is the object the Configuration
    // handed out, and mutating it would leak the mode into every later resolve
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerRun } };

    class NoTxDownRun_2021_01_03_00_00_00 extends OrmMigration {
      public transaction = false;
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }), row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 }), row({ Migration: 'NoTxDownRun_2021_01_03_00_00_00', Batch: 1 })]);

    // a transaction count alone cannot tell "MigB+MigA wrapped, NoTx outside" from "all three
    // wrapped" - so record whether each down() actually saw an ambient transaction
    const inTransaction: Record<string, boolean> = {};
    const track = (name: string) => async (c: OrmDriver) => {
      inTransaction[name] = c.CurrentTransaction !== undefined;
    };
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'down').callsFake(track('MigA'));
    sinon.stub(MigB_2021_01_02_00_00_00.prototype, 'down').callsFake(track('MigB'));
    sinon.stub(NoTxDownRun_2021_01_03_00_00_00.prototype, 'down').callsFake(track('NoTx'));

    const tr = sinon.spy(FakeSqliteDriver.prototype, 'transaction');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00), unit(NoTxDownRun_2021_01_03_00_00_00)]);

    // segmented like up(), not refused: a PerRun connection holding one opted-out migration
    // must still be able to roll the whole batch back
    expect(tr.callCount).to.eq(1); // MigB+MigA in one tx; NoTx outside
    expect(inTransaction).to.eql({ NoTx: false, MigB: true, MigA: true });
    expect(executed.map((e) => e.constructor.name)).to.eql(['NoTxDownRun_2021_01_03_00_00_00', 'MigB_2021_01_02_00_00_00', 'MigA_2021_01_01_00_00_00']);
  });

  it('down() under PerMigration wraps each rollback in its own transaction, transaction=false runs outside', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Transaction: { Mode: MigrationTransactionMode.PerMigration } };

    class NoTxDownMig_2021_01_03_00_00_00 extends OrmMigration {
      public transaction = false;
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }), row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 }), row({ Migration: 'NoTxDownMig_2021_01_03_00_00_00', Batch: 1 })]);

    const inTransaction: Record<string, boolean> = {};
    const track = (name: string) => async (c: OrmDriver) => {
      inTransaction[name] = c.CurrentTransaction !== undefined;
    };
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'down').callsFake(track('MigA'));
    sinon.stub(MigB_2021_01_02_00_00_00.prototype, 'down').callsFake(track('MigB'));
    sinon.stub(NoTxDownMig_2021_01_03_00_00_00.prototype, 'down').callsFake(track('NoTx'));

    const tr = sinon.spy(FakeSqliteDriver.prototype, 'transaction');
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00), unit(NoTxDownMig_2021_01_03_00_00_00)]);

    // one transaction per wrapped migration - 1 would mean PerRun's shared transaction, 3 would
    // mean the opt-out was ignored
    expect(tr.callCount).to.eq(2);
    expect(inTransaction).to.eql({ NoTx: false, MigB: true, MigA: true });
    expect(executed.map((e) => e.constructor.name)).to.eql(['NoTxDownMig_2021_01_03_00_00_00', 'MigB_2021_01_02_00_00_00', 'MigA_2021_01_01_00_00_00']);
  });

  it('a failing down() is wrapped with the migration name and connection', async () => {
    const driver = await makeDriver();
    stubDb([row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 })]);
    sinon.stub(MigB_2021_01_02_00_00_00.prototype, 'down').rejects(new Error('drop exploded'));
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.down([unit(MigB_2021_01_02_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('MigB_2021_01_02_00_00_00');
      expect(e.message, 'the operator needs to know which connection died').to.contain('sqlite');
      expect(e.message).to.contain('drop exploded');
    }
  });

  it('down() that reverts but cannot remove its row says so loudly', async () => {
    const driver = await makeDriver();
    // default mode is None, so nothing unwinds the successful down() when the delete dies
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return [row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 })];
      }
      if (b instanceof DeleteQueryBuilder) {
        throw new Error('row lock timeout');
      }
      return [{ 1: 1 }];
    });
    const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);
    const error = sinon.spy((svc as any).Log, 'error');

    try {
      await svc.down([unit(MigB_2021_01_02_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('MigB_2021_01_02_00_00_00');
      expect(e.message).to.contain('row lock timeout');
    }

    expect(dB.calledOnce, 'the schema really was reverted before the delete failed').to.be.true;

    const loud = error.getCalls().find((c) => String(c.args[0]).includes('MigB_2021_01_02_00_00_00'));
    expect(loud, 'expected a loud log about the reverted-but-still-recorded migration').to.not.be.undefined;
    expect(String(loud!.args[0])).to.contain('still reports this migration as applied');
  });

  it('down() warns about the failed and orphaned rows it steps around', async () => {
    const driver = await makeDriver();
    stubDb([
      row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }),
      row({ Migration: 'Ghost_2020_12_31_00_00_00', Batch: 1 }), // applied, but its class is gone
      row({ Migration: 'MigB_2021_01_02_00_00_00', FinishedAt: null, Logs: 'kaboom' }), // failed
    ]);
    const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);
    const warn = sinon.spy((svc as any).Log, 'warn');

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00)]);

    expect(dA.calledOnce, 'the rollback still runs what it can').to.be.true;
    expect(executed).to.have.length(1);

    const orphan = warn.getCalls().find((c) => String(c.args[0]).includes('Ghost_2020_12_31_00_00_00'));
    expect(orphan, 'expected a warning naming the row no registered migration matches').to.not.be.undefined;

    const failed = warn.getCalls().find((c) => String(c.args[0]).includes('MigB_2021_01_02_00_00_00'));
    expect(failed, 'expected a warning naming the failed row the rollback skipped').to.not.be.undefined;
    expect(String(failed!.args[0])).to.contain('resolve');
  });

  it('resolve applied / rolled-back mutate the failed row', async () => {
    const driver = await makeDriver();
    const exec = stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'x' })]);
    const svc = new DefaultMigrationService(driver);

    await svc.resolve('MigA_2021_01_01_00_00_00', 'applied');
    let updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
    expect(((updates.at(-1)!.args[0] as UpdateQueryBuilder<unknown>).Value as any).FinishedAt).to.be.instanceOf(Date);

    await svc.resolve('MigA_2021_01_01_00_00_00', 'rolled-back');
    updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
    expect(((updates.at(-1)!.args[0] as UpdateQueryBuilder<unknown>).Value as any).RolledBackAt).to.be.instanceOf(Date);
  });

  it('resolve on unknown or healthy migration throws', async () => {
    const driver = await makeDriver();
    stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00' })]); // healthy
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.resolve('MigA_2021_01_01_00_00_00', 'applied');
      expect.fail('should throw');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('not in failed state');
    }

    try {
      await svc.resolve('NeverHeardOf_2021_01_09_00_00_00', 'applied');
      expect.fail('should throw');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('not in failed state');
    }
  });

  it('resolving as rolled-back clears the failed state so the next run is not blocked', async () => {
    const driver = await makeDriver();
    const table = [row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'kaboom' })];

    // only one row lives in this table, so the where clause needs no modelling
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return table.map((r) => ({ ...r }));
      }
      if (b instanceof UpdateQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        Object.assign(table[0], b.Value as any);
      }
      return [{ 1: 1 }];
    });
    const upA = sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').resolves();
    const svc = new DefaultMigrationService(driver);

    await svc.resolve('MigA_2021_01_01_00_00_00', 'rolled-back');

    // the blocking pair is FinishedAt NULL *and* Logs set, so stamping RolledBackAt alone
    // leaves the row still blocking - Logs is what has to go for it to be pending again
    expect(table[0].RolledBackAt).to.be.instanceOf(Date);
    expect(table[0].Logs, 'a resolved row must no longer look failed').to.be.null;

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    expect(upA.calledOnce, 'the resolved migration must be runnable again').to.be.true;
    expect(executed).to.have.length(1);
  });

  it('resolving as applied stamps a real batch and checksum, so the next default down() reaches it', async () => {
    const driver = await makeDriver();
    // MigA died on its very first attempt: upsertStart inserted Batch 0 and markFinished never
    // ran. MigB is a healthy row from an earlier run, and it is what pushes max(Batch) past 0
    const table = [row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'kaboom', Batch: 0 }), row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 })];

    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        return table.map((r) => ({ ...r }));
      }
      // resolve() is the only statement in this test that updates the table, and it targets
      // MigA - so the where clause needs no modelling
      if (b instanceof UpdateQueryBuilder && b.Table === MIGRATION_TABLE_NAME) {
        Object.assign(table[0], b.Value as any);
      }
      return [{ 1: 1 }];
    });
    const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
    const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
    const svc = new DefaultMigrationService(driver);

    await svc.resolve('MigA_2021_01_01_00_00_00', 'applied', unit(MigA_2021_01_01_00_00_00));

    expect(table[0].FinishedAt).to.be.instanceOf(Date);
    // left at 0 it would sit below every real batch and never be picked by a default down()
    expect(table[0].Batch, 'a hand-resolved row must carry a real batch').to.eq(2);
    expect(table[0].Checksum, 'without a checksum drift can never be detected for it').to.eq(migrationChecksum(MigA_2021_01_01_00_00_00));

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

    expect(dA.calledOnce, 'the resolved migration must be reachable without { all: true }').to.be.true;
    expect(dB.called, 'only the last batch rolls back by default').to.be.false;
    expect(executed.map((e) => e.constructor.name)).to.eql(['MigA_2021_01_01_00_00_00']);
  });

  it('status() merges registry with records', async () => {
    const driver = await makeDriver();
    const exec = stubDb([
      row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1, Checksum: 'deadbeef' }), // mismatch
      row({ Migration: 'MigB_2021_01_02_00_00_00', FinishedAt: null, Logs: 'x' }), // failed
    ]);
    const svc = new DefaultMigrationService(driver);

    const st = await svc.status([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

    // deliberately unlocked, unlike up()/down(): a read-only report must not block for the whole
    // Timeout behind a running migration, which is exactly when somebody asks for it
    expect(
      exec.getCalls().some((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === LOCK_TABLE),
      'status() must not take the migration lock',
    ).to.be.false;

    expect(st.find((s) => s.name.startsWith('MigA'))!.applied).to.be.true;
    expect(st.find((s) => s.name.startsWith('MigA'))!.checksumMismatch).to.be.true;
    expect(st.find((s) => s.name.startsWith('MigB'))!.failed).to.be.true;
    expect(st.find((s) => s.name.startsWith('MigB'))!.pending).to.be.false;
  });
});

describe('DefaultMigrationService lock', () => {
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

  it('acquires and releases the lock around up()', async () => {
    const driver = await makeDriver();
    const exec = stubDb([]);
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00)]);
    expect(executed, 'the run itself must still happen').to.have.length(1);

    const calls = exec.getCalls();
    const lockInserts = calls.filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === LOCK_TABLE);
    const lockDeletes = calls.filter((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as DeleteQueryBuilder<unknown>).Table === LOCK_TABLE);
    expect(lockInserts, 'exactly one acquire').to.have.length(1);
    expect(lockDeletes, 'exactly one release').to.have.length(1);

    // the row identifies who is holding it, otherwise a stuck lock names nobody
    expect(String((lockInserts[0].args[0] as InsertQueryBuilder).getColumnValues('Owner')[0])).to.contain(String(process.pid));
    expect((lockInserts[0].args[0] as InsertQueryBuilder).getColumnValues('AcquiredAt')[0]).to.be.instanceOf(Date);

    // counting the pair is not enough - it has to actually bracket the run
    const at = (pred: (b: any) => boolean) => calls.findIndex((c) => pred(c.args[0]));
    const trackingInsert = at((b) => b instanceof InsertQueryBuilder && b.Table === MIGRATION_TABLE_NAME);
    expect(trackingInsert, 'the migration row was written').to.be.greaterThan(-1);
    expect(at((b) => b instanceof InsertQueryBuilder && b.Table === LOCK_TABLE), 'the lock is taken before any migration work').to.be.lessThan(trackingInsert);
    expect(at((b) => b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE), 'the lock is released after the migration work').to.be.greaterThan(trackingInsert);
  });

  it('releases the lock even when the migration throws', async () => {
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

    // a lock left behind by a failed run blocks the connection until it goes stale
    const lockDeletes = exec.getCalls().filter((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as DeleteQueryBuilder<unknown>).Table === LOCK_TABLE);
    expect(lockDeletes, 'a failed run must still release the lock').to.have.length(1);
  });

  it('fresh foreign lock: times out naming the holder, and never evicts it', async () => {
    const driver = await makeDriver();
    // replaced rather than mutated in place: Options.Migration is the object the Configuration
    // handed out, and mutating it would leak the lock settings into every later resolve
    driver.Options.Migration = { ...driver.Options.Migration, Lock: { Timeout: 600, StaleAfter: 60_000 } };

    const ops: string[] = [];
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof InsertQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-insert');
        throw new Error('UNIQUE constraint failed');
      }
      if (b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-delete');
        return [{ 1: 1 }];
      }
      // held right now by somebody else, well inside the staleness window
      if (b instanceof SelectQueryBuilder && b.Table === LOCK_TABLE) return [{ Id: 1, AcquiredAt: new Date(), Owner: 'other:123' }];
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    const upA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'up');
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message, 'the operator needs to know who is holding it').to.contain('other:123');
      expect(e.message).to.contain('sqlite');
    }

    expect(upA.called, 'nothing may run without the lock').to.be.false;
    // it polled rather than giving up on the first refusal
    expect(ops.filter((o) => o === 'lock-insert').length).to.be.greaterThan(1);
    // and a failed acquisition must never delete the row - that is somebody else's lock
    expect(ops, 'a timed-out acquire must not evict the holder').to.not.include('lock-delete');
  }).timeout(5000);

  it('steals a stale lock and says so', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Lock: { Timeout: 5_000, StaleAfter: 1_000 } };

    const ops: string[] = [];
    let insertAttempt = 0;
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof InsertQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-insert');
        insertAttempt++;
        // the stale row is still there on the first attempt, gone once it has been stolen
        if (insertAttempt === 1) throw new Error('UNIQUE constraint failed');
        return [];
      }
      if (b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-delete');
        return [{ 1: 1 }];
      }
      // abandoned 10s ago by a process that died, well past StaleAfter
      if (b instanceof SelectQueryBuilder && b.Table === LOCK_TABLE) return [{ Id: 1, AcquiredAt: new Date(Date.now() - 10_000), Owner: 'dead:1' }];
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);
    const warn = sinon.spy((svc as any).Log, 'warn');

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    expect(executed, 'the run proceeds once the stale lock is gone').to.have.length(1);
    // refused, stolen, retaken, released - the whole steal protocol, in order
    expect(ops).to.eql(['lock-insert', 'lock-delete', 'lock-insert', 'lock-delete']);
    expect(insertAttempt).to.eq(2);

    const stolen = warn.getCalls().find((c) => String(c.args[0]).includes('dead:1'));
    expect(stolen, 'stealing a lock must be loud - it may be a live process the clock disagrees with').to.not.be.undefined;
  });

  it('a steal that does not free the row is bounded, not an endless spin', async () => {
    const driver = await makeDriver();
    // long enough that all three steals are reached even on a slow machine, short enough that
    // the poll loop after the cap ends the acquire in about a second
    driver.Options.Migration = { ...driver.Options.Migration, Lock: { Timeout: 700, StaleAfter: 1_000 } };

    const ops: string[] = [];
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof InsertQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-insert');
        throw new Error('UNIQUE constraint failed');
      }
      // the DELETE reports success and removes nothing, so the next read finds the same stale
      // row: the steal never converges. A crashed run that left a row this where clause does not
      // match looks exactly like this, and it happens on a boot path
      if (b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE) {
        ops.push('lock-delete');
        return [{ 1: 1 }];
      }
      if (b instanceof SelectQueryBuilder && b.Table === LOCK_TABLE) return [{ Id: 1, AcquiredAt: new Date(Date.now() - 10_000), Owner: 'dead:1' }];
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    const upA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'up');
    const svc = new DefaultMigrationService(driver);
    const warn = sinon.spy((svc as any).Log, 'warn');

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      // the acquire has to end in an error - retrying silently forever raises nothing at all
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message, 'the operator needs to know which row is stuck').to.contain('dead:1');
      expect(e.message).to.contain('sqlite');
      expect(e.message, 'and where to delete it by hand').to.contain(LOCK_TABLE);
    }

    expect(upA.called, 'nothing may run without the lock').to.be.false;
    // the spin showed up as a steal per turn with no sleep between them: capped, so the delete
    // and its warning are issued a bounded number of times and the loop falls back to polling
    expect(ops.filter((o) => o === 'lock-delete').length, 'steals must be capped').to.eq(MIGRATION_LOCK_MAX_STEALS);
    expect(warn.getCalls().filter((c) => String(c.args[0]).includes('Stealing stale')).length, 'one warning per steal and no more - this runs on boot').to.eq(MIGRATION_LOCK_MAX_STEALS);
    // an unbounded loop issues thousands of these in the same window
    expect(ops.filter((o) => o === 'lock-insert').length, 'the retry loop must poll, not spin').to.be.at.most(MIGRATION_LOCK_MAX_STEALS + 4);
  }).timeout(5000);

  it('Lock.Enabled false skips the lock entirely', async () => {
    const driver = await makeDriver();
    driver.Options.Migration = { ...driver.Options.Migration, Lock: { Enabled: false } };
    const exec = stubDb([]);
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    expect(executed, 'the run still happens').to.have.length(1);
    expect(exec.getCalls().some((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === LOCK_TABLE), 'no acquire').to.be.false;
    expect(exec.getCalls().some((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as DeleteQueryBuilder<unknown>).Table === LOCK_TABLE), 'no release').to.be.false;
  });

  it('a lock that cannot be released does not mask the migration error', async () => {
    const driver = await makeDriver();
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof DeleteQueryBuilder && b.Table === LOCK_TABLE) throw new Error('lock table vanished');
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('ddl exploded'));
    const svc = new DefaultMigrationService(driver);
    const error = sinon.spy((svc as any).Log, 'error');

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should have thrown');
    } catch (e: any) {
      // a throw out of the release would replace the in-flight error and hide why the run died
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message, 'the migration failure is what the operator needs, not the release failure').to.contain('ddl exploded');
    }

    const loud = error.getCalls().find((c) => String(c.args[0]).includes('lock table vanished'));
    expect(loud, 'a lock left behind must still be reported, even though it is not rethrown').to.not.be.undefined;
    expect(String(loud!.args[0]), 'the operator has to be told which row to clear').to.contain(LOCK_TABLE);
  });

  it('down() takes the lock too', async () => {
    const driver = await makeDriver();
    const exec = stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 })]);
    const svc = new DefaultMigrationService(driver);

    const executed = await svc.down([unit(MigA_2021_01_01_00_00_00)]);

    expect(executed).to.have.length(1);
    expect(exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === LOCK_TABLE)).to.have.length(1);
    expect(exec.getCalls().filter((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as DeleteQueryBuilder<unknown>).Table === LOCK_TABLE)).to.have.length(1);
  });
});

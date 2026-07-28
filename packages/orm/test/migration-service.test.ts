import { Configuration } from '@spinajs/configuration';
import { DI, Bootstrapper } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, ConnectionConf, FakeTableQueryCompiler, FakeColumnQueryCompiler, FakeTableExistsCompiler, FakeDefaultValueBuilder, TEST_TABLE_INFO } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, TableExistsCompiler, DefaultValueBuilder, DefaultMigrationService, MIGRATION_TABLE_NAME, migrationChecksum, OrmMigration } from '../src/index.js';
import { TableQueryBuilder, AlterTableQueryBuilder, RawSchemaQueryBuilder } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

const expect = chai.expect;

async function makeDriver(): Promise<FakeSqliteDriver> {
  // resolve driver exactly like Orm does, with the sqlite connection options from ConnectionConf
  const conf = await DI.resolve(Configuration);
  const opts = conf.get<any[]>('db.Connections').find((c: any) => c.Name === 'sqlite');
  return (await DI.resolve<OrmDriver>('sqlite', [opts])) as FakeSqliteDriver;
}

describe('DefaultMigrationService storage', () => {
  before(() => {
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
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();
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

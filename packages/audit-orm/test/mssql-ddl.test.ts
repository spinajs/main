import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Builder, ICompilerOutput, OrmMigration } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, AuditTrailTableMigration } from '../src/index.js';

const BIN2 = 'COLLATE Latin1_General_100_BIN2';

// No server: resolving the driver registers its compilers, and a stand-in for execute records what it would send. The
// stand-in replaces execute rather than executeOnDb because execute logs first, and an unbooted driver has no logger.
describe('audit-orm DDL on mssql', function () {
  this.timeout(15000);

  async function ddlOf(migration: OrmMigration): Promise<string> {
    const driver = await DI.child().resolve(MsSqlOrmDriver, [{ Name: 'audit-orm-mssql-ddl', Driver: 'orm-driver-mssql' }]);
    const sent: string[] = [];
    driver.execute = (builder: Builder<unknown>) => {
      const compiled: ICompilerOutput[] = [builder.toDB()].flat();
      sent.push(...compiled.map((c) => c.expression ?? ''));
      return Promise.resolve([]);
    };
    await migration.up(driver);
    return sent.join(';\n');
  }

  it('creates the buffer with an identity seq and its trail index', async () => {
    const ddl = await ddlOf(new AuditOutboxTableMigration());
    expect(ddl).to.contain('[seq] BIGINT IDENTITY(1,1) PRIMARY KEY');
    expect(ddl).to.contain(`[trail] NVARCHAR(64) ${BIN2} NOT NULL`);
    expect(ddl).to.contain(`[id] NVARCHAR(36) ${BIN2} NOT NULL`);
    expect(ddl).to.contain(`[data_hash] NVARCHAR(64) ${BIN2}`);
    expect(ddl).to.contain('CREATE INDEX [audit_outbox_trail] ON [audit_outbox] ([trail],[seq])');
  });

  it('creates the archive with a source column, five indexes and a unique id', async () => {
    const ddl = await ddlOf(new AuditArchiveTableMigration());
    expect(ddl).to.contain(`[source] NVARCHAR(64) ${BIN2} NOT NULL`);
    for (const index of ['audit_event_subject', 'audit_event_subject_action', 'audit_event_actor', 'audit_event_trace', 'audit_event_at']) expect(ddl).to.contain(`[${index}]`);
    expect(ddl).to.contain('CREATE UNIQUE INDEX [audit_event_id] ON [audit_event] ([id])');
  });

  it('creates audit_seal with its unique range index', async () => {
    const ddl = await ddlOf(new AuditSealTableMigration());
    expect(ddl).to.contain('[id] BIGINT IDENTITY(1,1) PRIMARY KEY');
    for (const column of [`[trail_table] NVARCHAR(128) ${BIN2} NOT NULL`, '[from_seq] BIGINT NOT NULL', '[to_seq] BIGINT NOT NULL', `[events_hash] NVARCHAR(64) ${BIN2} NOT NULL`, `[hash] NVARCHAR(64) ${BIN2} NOT NULL`, `[previous_hash] NVARCHAR(64) ${BIN2}`]) expect(ddl).to.contain(column);
    expect(ddl).to.contain('CREATE UNIQUE INDEX [audit_seal_range] ON [audit_seal] ([trail_table],[from_seq])');
  });

  it('creates the trail table with millisecond at and an unbounded payload', async () => {
    const ddl = await ddlOf(new AuditTrailTableMigration());
    expect(ddl).to.contain('[seq] BIGINT IDENTITY(1,1) PRIMARY KEY');
    expect(ddl).to.contain('[at] DATETIMEOFFSET(3) NOT NULL');
    expect(ddl).to.contain(`[data] NVARCHAR(MAX) ${BIN2} NOT NULL`);
    for (const index of ['audit_event_subject', 'audit_event_actor', 'audit_event_trace', 'audit_event_at']) expect(ddl).to.contain(`[${index}]`);
  });

  // A default collation folds case, and VARCHAR keeps only code page 1252: 'ABC' would be erased with 'abc'.
  it('gives every text column of every table a binary collation over NVARCHAR', async () => {
    for (const migration of [new AuditTrailTableMigration(), new AuditOutboxTableMigration(), new AuditArchiveTableMigration(), new AuditSealTableMigration()]) {
      const [createTable] = (await ddlOf(migration)).split(';\n');
      const columns = createTable.split(/,(?=\[)/).filter((c) => c.includes('VARCHAR'));
      expect(columns).to.have.length.greaterThan(3);
      expect(columns.filter((c) => !c.includes('NVARCHAR(') || !c.includes(BIN2))).to.deep.eq([]);
    }
  });
});

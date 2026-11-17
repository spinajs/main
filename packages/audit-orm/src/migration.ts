import { AUDIT_WIDTHS } from '@spinajs/audit';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver, TableQueryBuilder } from '@spinajs/orm';

export const AUDIT_EVENT_TABLE = 'audit_event';

/** Declares the event columns of a trail table, `id` to `data_hash`. The caller declares `seq` and any column of its own (a buffer's `trail`, an archive's `source`). */
export function auditEventColumns(table: TableQueryBuilder): void {
  const W = AUDIT_WIDTHS;
  table.string('id', W.id).notNull();
  table.dateTime('at').notNull();
  table.string('kind', W.kind).notNull();
  table.string('action', W.action).notNull();
  table.string('subject_type', W.subject_type);
  table.string('subject_id', W.subject_id);
  table.string('outcome', W.outcome).notNull();
  table.string('actor', W.actor).notNull();
  table.string('on_behalf_of', W.on_behalf_of);
  table.string('trace_id', W.trace_id);
  table.string('origin', W.origin);
  table.string('tenant', W.tenant);
  table.string('decision_id', W.decision_id);
  table.string('idempotency_key', W.idempotency_key);
  table.string('data_subject', W.data_subject);
  // TEXT on MySQL holds 64 KB; LONGTEXT is TEXT on Postgres and sqlite and NVARCHAR(MAX) on MSSQL.
  table.longtext('data').notNull();
  table.string('data_hash', W.data_hash);
}

/** Creates one trail table. For another table or connection, extend it: override `table()` and add `@Migration(connection)`. */
export class AuditTrailTableMigration extends OrmMigration {
  protected table(): string {
    return AUDIT_EVENT_TABLE;
  }

  public async up(connection: OrmDriver): Promise<void> {
    const name = this.table();
    await connection.schema().createTable(name, (table) => {
      table.bigint('seq').primaryKey().autoIncrement();
      auditEventColumns(table);
    });
    await connection.index().table(name).name(`${name}_subject`).columns(['subject_type', 'subject_id', 'seq']);
    await connection.index().table(name).name(`${name}_actor`).columns(['actor', 'seq']);
    await connection.index().table(name).name(`${name}_trace`).columns(['trace_id']);
    await connection.index().table(name).name(`${name}_at`).columns(['at']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(this.table()).ifExists();
  }
}

@Migration('default')
export class AuditEvent_2026_11_16_00_00_00 extends AuditTrailTableMigration {}

import { AUDIT_WIDTHS } from '@spinajs/audit';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver, TableQueryBuilder } from '@spinajs/orm';

export const AUDIT_EVENT_TABLE = 'audit_event';

/** Declares the event columns of a trail table, `id` to `data_hash`, every text column `exact()`. The caller declares `seq` and any column of its own (a buffer's `trail`, an archive's `source`). */
export function auditEventColumns(table: TableQueryBuilder): void {
  const W = AUDIT_WIDTHS;
  table.string('id', W.id).notNull().exact();
  table.dateTime('at').notNull();
  table.string('kind', W.kind).notNull().exact();
  table.string('action', W.action).notNull().exact();
  table.string('subject_type', W.subject_type).exact();
  table.string('subject_id', W.subject_id).exact();
  table.string('outcome', W.outcome).notNull().exact();
  table.string('actor', W.actor).notNull().exact();
  table.string('on_behalf_of', W.on_behalf_of).exact();
  table.string('trace_id', W.trace_id).exact();
  table.string('origin', W.origin).exact();
  table.string('tenant', W.tenant).exact();
  table.string('decision_id', W.decision_id).exact();
  table.string('idempotency_key', W.idempotency_key).exact();
  table.string('data_subject', W.data_subject).exact();
  // TEXT on MySQL holds 64 KB; LONGTEXT is TEXT on Postgres and sqlite and NVARCHAR(MAX) on MSSQL. exact(): a
  // database default such as latin1 cannot hold every payload.
  table.longtext('data').notNull().exact();
  table.string('data_hash', W.data_hash).exact();
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

import { OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUDIT_EVENT_TABLE, auditEventColumns } from '../migration.js';
import { AUDIT_OUTBOX_TABLE, AUDIT_SOURCE_WIDTH, AUDIT_TRAIL_WIDTH } from './table.js';

/** Extend it with your own `@Migration(name)` on every connection that buffers events of a shipping trail. */
export class AuditOutboxTableMigration extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(AUDIT_OUTBOX_TABLE, (table) => {
      table.bigint('seq').primaryKey().autoIncrement();
      table.string('trail', AUDIT_TRAIL_WIDTH).notNull();
      auditEventColumns(table);
    });
    await connection.index().table(AUDIT_OUTBOX_TABLE).name('audit_outbox_trail').columns(['trail', 'seq']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(AUDIT_OUTBOX_TABLE).ifExists();
  }
}

/**
 * Extend it with your own `@Migration(name)` on the archive connection of a shipping trail. The archive table is the
 * trail's `table` there, with a `source` column for the connection each event was recorded on.
 */
export class AuditArchiveTableMigration extends OrmMigration {
  /** The archive table: the `table` of the shipping trail. Override for a trail whose table is not `audit_event`. */
  protected table(): string {
    return AUDIT_EVENT_TABLE;
  }

  public async up(connection: OrmDriver): Promise<void> {
    const name = this.table();
    await connection.schema().createTable(name, (table) => {
      table.bigint('seq').primaryKey().autoIncrement();
      table.string('source', AUDIT_SOURCE_WIDTH).notNull();
      auditEventColumns(table);
    });
    await connection.index().table(name).name(`${name}_subject`).columns(['source', 'subject_type', 'subject_id', 'seq']);
    await connection.index().table(name).name(`${name}_actor`).columns(['source', 'actor', 'seq']);
    await connection.index().table(name).name(`${name}_trace`).columns(['trace_id']);
    await connection.index().table(name).name(`${name}_at`).columns(['at']);
    await connection.index().table(name).name(`${name}_id`).columns(['id']).unique();
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(this.table()).ifExists();
  }
}

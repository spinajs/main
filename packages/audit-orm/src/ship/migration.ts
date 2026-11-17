import { OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { auditEventColumns } from '../migration.js';
import { AUDIT_OUTBOX_TABLE, AUDIT_TRAIL_WIDTH } from './table.js';

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

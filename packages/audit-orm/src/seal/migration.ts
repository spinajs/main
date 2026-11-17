import { OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUDIT_SEAL_TABLE, AUDIT_SEAL_TABLE_NAME_WIDTH } from './table.js';

/** Extend it with your own `@Migration(name)` on every connection that holds the table of a sealed trail (for a shipping trail: its archive connection). */
export class AuditSealTableMigration extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(AUDIT_SEAL_TABLE, (table) => {
      table.bigint('id').primaryKey().autoIncrement();
      table.string('trail_table', AUDIT_SEAL_TABLE_NAME_WIDTH).notNull();
      table.bigint('from_seq').notNull();
      table.bigint('to_seq').notNull();
      table.int('event_count').notNull();
      table.string('hash', 64).notNull();
      table.string('previous_hash', 64);
      table.dateTime('sealed_at').notNull();
      table.dateTime('pruned_at');
    });
    // Unique: every seal chained from one seal starts at the same seq, so a second one is refused.
    await connection.index().table(AUDIT_SEAL_TABLE).name('audit_seal_range').columns(['trail_table', 'from_seq']).unique();
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(AUDIT_SEAL_TABLE).ifExists();
  }
}

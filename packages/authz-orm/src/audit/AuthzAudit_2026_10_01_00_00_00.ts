import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUDIT_CONNECTION, AUDIT_TABLE } from './model.js';

@Migration(AUDIT_CONNECTION)
export class AuthzAudit_2026_10_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(AUDIT_TABLE, (table) => {
      table.string('id', 36).primaryKey().notNull();
      table.dateTime('at').notNull();
      table.string('kind', 16).notNull();
      table.string('principal', 100).notNull();
      table.string('permission', 160);
      table.string('resource', 255);
      table.string('reason', 255);
      table.text('trace');
    });

    await connection.index().table(AUDIT_TABLE).name('authz_audit_at').columns(['at']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(AUDIT_TABLE).ifExists();
  }
}

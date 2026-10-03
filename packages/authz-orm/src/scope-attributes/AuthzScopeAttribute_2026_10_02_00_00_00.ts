import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** Table authz_scope_attribute (design §9.1): one row per scalar leaf path of a scope node's attributes. */
@Migration('default')
export class AuthzScopeAttribute_2026_10_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authz_scope_attribute', (table) => {
      table.string('scope_type', 64).notNull().primaryKey();
      table.string('scope_id', 64).notNull().primaryKey();
      table.string('path', 160).notNull().primaryKey();
      table.string('value_json', 1024).notNull();
      table.string('value_text', 255);
      table.decimal('value_num', 20, 6);
      table.string('updated_by', 100);
      table.dateTime('updated_at').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authz_scope_attribute');
  }
}

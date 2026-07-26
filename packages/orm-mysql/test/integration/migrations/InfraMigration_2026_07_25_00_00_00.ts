/* eslint-disable @typescript-eslint/no-empty-function */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('mysql')
export class InfraMigration_2026_07_25_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('mysql_auto_key', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name');
    });

    await connection.schema().createTable('mysql_uuid_key', (table) => {
      table.string('Id', 36).notNull().primaryKey();
      table.string('Name');
    });

    // Two @Primary() columns compile to one table-level `PRIMARY KEY (TenantId, Code)`.
    await connection.schema().createTable('mysql_composite_key', (table) => {
      table.int('TenantId').notNull().primaryKey();
      table.string('Code', 32).notNull().primaryKey();
      table.string('Name');
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class UkMigration_2026_11_23_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('uk_order', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('uk_tag', (table) => {
      table.uuid('Id').primaryKey().unique();
      table.string('Name');
    });

    await connection.schema().createTable('uk_order_tag', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('order_id');
      table.uuid('tag_id');
    });

    await connection.schema().createTable('uk_item', (table) => {
      table.uuid('Id').primaryKey().unique();
      table.string('Name');
      table.int('order_id');
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }
}

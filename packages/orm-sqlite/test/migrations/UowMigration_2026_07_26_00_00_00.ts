/* eslint-disable prettier/prettier */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

// `.unique()` on every primary key is required for the sync()/upsert paths:
// InsertQueryBuilder.onDuplicate() derives its conflict columns from descriptor columns
// flagged Unique, and SqliteOnDuplicateQueryCompiler throws when that list is empty.
@Migration('sqlite')
export class UowMigration_2026_07_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('uow_client', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('uow_order', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('Total');
      table.int('client_id');
    });

    await connection.schema().createTable('uow_order_item', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Sku');
      table.int('Qty');
      table.int('order_id');
    });

    // order_id is NOT NULL on purpose: this is what makes the default orphan policy
    // escalate from nullify to delete for the StrictItems relation.
    await connection.schema().createTable('uow_strict_item', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Sku');
      table.int('order_id').notNull();
    });

    await connection.schema().createTable('uow_tag', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('uow_order_tag', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('order_id');
      table.int('tag_id');
    });

    await connection.schema().createTable('uow_node', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.int('parent_id');
    });

    await connection.schema().createTable('uow_cycle_a', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('b_id');
    });

    await connection.schema().createTable('uow_cycle_b', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('a_id');
    });

    // A belongsTo whose declared join column is NOT the target's primary key.
    await connection.schema().createTable('uow_alt_target', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Code');
      table.string('Label');
    });

    await connection.schema().createTable('uow_alt_owner', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('target_code');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

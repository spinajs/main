/* eslint-disable prettier/prettier */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('mysql')
export class IntegrationUowMigration_2026_07_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('uow_client', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name');
    });

    // Real FK constraints on purpose: MySQL rejects a child written before its parent, so
    // this is what actually proves the topological insert order rather than merely
    // exercising it. SQLite does not enforce them unless PRAGMA foreign_keys is on.
    await connection.schema().createTable('uow_order', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('Total');
      table.int('client_id');
      table.foreignKey('client_id').references('uow_client', 'Id');
    });

    await connection.schema().createTable('uow_order_item', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Sku');
      table.int('order_id');
      table.foreignKey('order_id').references('uow_order', 'Id');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('uow_order_item');
    await connection.schema().dropTable('uow_order');
    await connection.schema().dropTable('uow_client');
  }
}

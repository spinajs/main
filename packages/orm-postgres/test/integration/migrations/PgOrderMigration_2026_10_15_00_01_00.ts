/* eslint-disable @typescript-eslint/no-empty-function */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

// Real FK constraints: Postgres rejects a child written before its parent, which is what proves
// the unit of work's insert order rather than merely exercising it.
@Migration('postgres')
export class PgOrderMigration_2026_10_15_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('pg_client', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });

    await connection.schema().createTable('pg_order', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('Total');
      t.int('client_id');
      t.foreignKey('client_id').references('pg_client', 'Id');
    });

    await connection.schema().createTable('pg_order_item', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Sku');
      t.int('order_id');
      t.foreignKey('order_id').references('pg_order', 'Id');
    });

    await connection.schema().createTable('pg_tag', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });

    await connection.schema().createTable('pg_order_tag', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('order_id');
      t.int('tag_id');
      t.string('Note');
      t.foreignKey('order_id').references('pg_order', 'Id');
      t.foreignKey('tag_id').references('pg_tag', 'Id');
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

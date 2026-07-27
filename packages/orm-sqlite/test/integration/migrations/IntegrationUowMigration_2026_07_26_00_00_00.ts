/* eslint-disable prettier/prettier */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class IntegrationUowMigration_2026_07_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('integration_order', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('Total');
    });

    await connection.schema().createTable('integration_order_item', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Sku');
      table.int('order_id');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

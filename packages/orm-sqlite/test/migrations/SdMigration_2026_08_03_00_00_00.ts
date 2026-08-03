/* eslint-disable prettier/prettier */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class SdMigration_2026_08_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('sd_owner', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('sd_item', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
      table.int('owner_id');
      table.dateTime('DeletedAt');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

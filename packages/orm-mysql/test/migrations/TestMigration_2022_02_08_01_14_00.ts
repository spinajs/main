/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('mysql-2')
export class TestMigration_2022_02_08_01_14_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user_metadata', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('UserId').notNull();
      table.string('Key').notNull();
      table.string('Value');
      table.dateTime('CreatedAt').notNull();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

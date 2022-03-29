/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('mssql')
export class TestMigration_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user_test', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').notNull();
      table.string('Password').notNull();
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('test_model', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.dateTime('CreatedAt').notNull();
    });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

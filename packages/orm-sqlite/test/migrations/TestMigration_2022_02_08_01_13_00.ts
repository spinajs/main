/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class TestMigration_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').notNull().unique();
      table.string('Password').notNull();
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('test_model', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('owner_id');
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('test_model_owner', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.dateTime('CreatedAt').notNull();
    });


    await connection.schema().createTable('test_owned', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('owner_id');
      table.string('Val');
    });

    await connection.schema().createTable('test_many', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
      table.int('testmodel_id');
    });


    await connection.schema().createTable('category', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.int('parent_id');
    });

    await connection.index().unique().name('user_id_idx').columns(['Id', 'Name']).table('user');
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class configuration_db_source_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('configuration', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Slug', 64).notNull();
      table.text('Value');
      table.boolean('Required').notNull();
      table.string('Group', 32);
      table.string('Label', 64);
      table.string('Description', 256);
      table.text('Meta');
      table.enum('Type', ['int', 'float', 'string', 'json', 'date', 'datetime', 'time', 'boolean', 'time-range', 'date-range', 'datetime-range', 'range', 'oneOf', 'manyOf']);
    });

    await connection.index().unique().table('configuration').name('configuration_unique_slug').columns(['Slug']);
  }

  // tslint:disable-next-line: no-empty
  public async down(_connection: OrmDriver): Promise<void> {
    //_connection.schema().dropTable('configuration');
  }
}

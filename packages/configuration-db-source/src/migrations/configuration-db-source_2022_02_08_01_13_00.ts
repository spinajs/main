/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class ConfiguratioDbSourceInitialMigration extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('configuration', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Slug', 64).notNull();
      table.text('Value');
      table.string('Group', 32);
      table.enum('Type', ['int', 'float', 'string', 'json', 'date', 'datetime', 'time', 'boolean']);
    });

    await connection.index().unique().table('configuration').name('configuration_unique_slug').columns(['Slug']);
  }

  // tslint:disable-next-line: no-empty
  public async down(_connection: OrmDriver): Promise<void> {
    //_connection.schema().dropTable('configuration');
  }
}

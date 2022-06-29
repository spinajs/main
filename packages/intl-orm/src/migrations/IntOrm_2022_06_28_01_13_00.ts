/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class IntOrm_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('intl_resources', (table) => {
      table.int('ResourceId').notNull();
      table.string('Resource', 32).notNull();
      table.string('Column', 16).notNull();
      table.string('Lang', 6).notNull();
      table.text('Value');
    });

    await connection.schema().createTable('intl_translations', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Key', 32).notNull();
      table.text('Value');
      table.string('Lang', 6).notNull();
    });

    await connection.index().unique().table('intl_resources').name('intl_resources_idx').columns(['ResourceId', 'Resource', 'Column', 'Lang']);
    await connection.index().unique().table('intl_translations').name('intl_translations_idx').columns(['Key', 'Lang']);
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

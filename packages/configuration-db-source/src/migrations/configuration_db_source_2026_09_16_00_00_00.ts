/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class configuration_db_source_2026_09_16_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('configuration_file_history', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Slug', 64).notNull();
      table.string('Fs', 64).notNull();
      table.string('FileName', 255).notNull();
      table.string('OriginalName', 255).notNull();
      table.int('Size').notNull();
      table.string('Hash', 64).notNull();
      table.int('UploadedBy').notNull();
      table.dateTime('UploadedAt').notNull().default().dateTime();
      table.string('ArchivedPath', 512);
      table.dateTime('ArchivedAt');
    });

    await connection.index().table('configuration_file_history').name('configuration_file_history_slug_idx').columns(['Slug']);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

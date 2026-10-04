import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** fs_object of design §9.1 (OrmFileMetadataStore), plus updated_at. */
@Migration('default')
export class AuthzFsObject_2026_10_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('fs_object', (table) => {
      table.string('fs', 64).notNull().primaryKey();
      table.string('path', 512).notNull().primaryKey();
      table.string('owner_type', 32);
      table.string('owner_id', 64);
      table.string('scope_type', 64);
      table.string('scope_id', 64);
      table.text('tags');
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('fs_object');
  }
}

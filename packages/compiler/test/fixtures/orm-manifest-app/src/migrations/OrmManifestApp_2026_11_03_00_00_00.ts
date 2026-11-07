import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
export class OrmManifestApp_2026_11_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('accounts', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').notNull();
      table.dateTime('SeenAt');
      table.boolean('Active');
      // the e2e drift case runs the same app without a declared column
      if (process.env.ORM_E2E_DRIFT !== '1') table.string('Nickname');
      // no model declares it: a partial model
      table.string('Legacy');
    });
  }

  public async down(_: OrmDriver): Promise<void> {}
}

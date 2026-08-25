import { IDriverOptions, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * Tables for the hasManyToMany rbac fixture ( `../models/M2MModels.js` ): an owner, a target
 * that declares an rbac resource, and the junction between them.
 */
@Migration('default')
export class M2MRbacMigration_2026_08_24_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver<IDriverOptions>): Promise<void> {
    await connection.schema().createTable('m2m_owner', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Value');
    });

    await connection.schema().createTable('m2m_target', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('UserId');
      table.string('Segment');
      table.string('Value');
    });

    await connection.schema().createTable('m2m_junction', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('owner_id');
      table.int('target_id');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver<IDriverOptions>): Promise<void> {}
}

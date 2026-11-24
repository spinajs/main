import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class SfMigration_2026_11_24_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('sf_person', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('sf_friendship', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('person_id');
      table.int('friend_id');
      table.int('approver_id');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('sf_friendship');
    await connection.schema().dropTable('sf_person');
  }
}

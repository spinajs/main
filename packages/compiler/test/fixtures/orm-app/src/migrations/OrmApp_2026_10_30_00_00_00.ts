import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
export class OrmApp_2026_10_30_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('owners', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.dateTime('CreatedAt');
      table.dateTime('UpdatedAt');
      table.dateTime('DeletedAt');
      table.dateTime('SeenAt');
      table.string('Roles');
      table.boolean('Active');
    });
    await connection.schema().createTable('pets', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.int('owner_id');
    });
    await connection.schema().createTable('tags', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });
    await connection.schema().createTable('owner_tags', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('owner_id');
      table.int('tag_id');
      table.string('Note');
    });
    // Seeded: a model with @JunctionTable hydrates its junction row on construction, so only a query can build one.
    await connection.insert().into('tags').values({ Name: 'vip' });
  }

  public async down(_: OrmDriver): Promise<void> {}
}

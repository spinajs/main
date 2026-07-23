import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class DtoRelation_2026_07_23_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('users', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Uuid', 64).notNull();
    });
    await connection.insert().into('users').values({ Id: 100, Uuid: 'user-uuid-1' });
    await connection.insert().into('users').values({ Id: 200, Uuid: 'user-uuid-2' });

    await connection.schema().createTable('campaign', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Name', 64);
      table.int('author');
    });
    await connection.insert().into('campaign').values({ Id: 1, Name: 'initial', author: 200 });
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // no-op for tests
  }
}

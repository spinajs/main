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
    // Dedicated row for the update/FK-translation test so no test mutates the
    // Id 1 seed row that other assertions may come to rely on.
    await connection.insert().into('campaign').values({ Id: 2, Name: 'update-target', author: 200 });
    // Dedicated row for the HTTP route-level e2e tests.
    await connection.insert().into('campaign').values({ Id: 3, Name: 'e2e-target', author: 100 });
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // no-op for tests
  }
}

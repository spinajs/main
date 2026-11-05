import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

const LIKE_ROW_NAMES = ['100%', '1000', '50% off', 'a_b', 'axb', 'back\\slash', 'backxslash', 'tilde~x', 'tildeyx', 'Plain'];

@Migration('default')
export class LikeRow_2026_11_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('like_row', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Name', 64).notNull();
    });

    await connection
      .insert()
      .into('like_row')
      .values(LIKE_ROW_NAMES.map((Name, Id) => ({ Id: Id + 1, Name })));
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // no-op for tests
  }
}

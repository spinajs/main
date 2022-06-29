/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class Test_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('test', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
    });

    await connection.schema().createTable('test_rel_many', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('test_id').notNull();
      table.string('Text', 32).notNull();
    });

    await connection.insert().into('test').values({ Text: 'witaj', Id: 1 });
    await connection.insert().into('test').values({ Text: 'swiecie', Id: 2 });

    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'Test', Column: 'Text', Lang: 'en_GB', Value: 'hello' });
    await connection.insert().into('intl_resources').values({ ResourceId: 2, Resource: 'Test', Column: 'Text', Lang: 'en_GB', Value: 'world' });

    await connection.insert().into('test_rel_many').values({ Text: 'raz', test_id: 1 });
    await connection.insert().into('test_rel_many').values({ Text: 'dwa', test_id: 2 });

    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'TestRelOneToMany', Column: 'Text', Lang: 'en_GB', Value: 'one' });
    await connection.insert().into('intl_resources').values({ ResourceId: 2, Resource: 'TestRelOneToMany', Column: 'Text', Lang: 'en_GB', Value: 'two' });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

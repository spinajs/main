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

    await connection.schema().createTable('test2', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('owner_id');
      table.string('Text', 32).notNull();
    });

    await connection.schema().createTable('owner', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
      table.int('owner_id');
    });

    await connection.schema().createTable('owner2', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
    });

    await connection.insert().into('owner2').values({ Text: 'owner2 witaj', Id: 1 });

    await connection.insert().into('owner').values({ Text: 'owner witaj', Id: 1, owner_id: 1 });
    await connection.insert().into('test2').values({ Text: 'witaj', Id: 1, owner_id: 1 });

    await connection.insert().into('test').values({ Text: 'witaj', Id: 1 });
    await connection.insert().into('test').values({ Text: 'swiecie', Id: 2 });

    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'Owner', Column: 'Text', Lang: 'en_GB', Value: 'owner hello' });
    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'Owner2', Column: 'Text', Lang: 'en_GB', Value: 'owner2 hello' });

    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'Test', Column: 'Text', Lang: 'en_GB', Value: 'hello' });
    await connection.insert().into('intl_resources').values({ ResourceId: 2, Resource: 'Test', Column: 'Text', Lang: 'en_GB', Value: 'world' });

    await connection.insert().into('test_rel_many').values({ Text: 'raz', test_id: 1 });
    await connection.insert().into('test_rel_many').values({ Text: 'dwa', test_id: 2 });

    await connection.insert().into('intl_resources').values({ ResourceId: 1, Resource: 'TestRelOneToMany', Column: 'Text', Lang: 'en_GB', Value: 'one' });
    await connection.insert().into('intl_resources').values({ ResourceId: 2, Resource: 'TestRelOneToMany', Column: 'Text', Lang: 'en_GB', Value: 'two' });

    await connection.insert().into('intl_translations').values({ Key: 'hello world', Value: 'bla bla', Lang: 'en_US' });
    await connection.insert().into('intl_translations').values({ Key: 'hello world', Value: 'bla bla german', Lang: 'de_DE' });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

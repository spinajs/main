/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class Test_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('belongs', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
    });

    await connection.insert().into('belongs').values({ Text: 'belongs 1', Id: 1 });
    await connection.insert().into('belongs').values({ Text: 'belongs 1', Id: 2 });

    await connection.schema().createTable('test', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
      table.int('belongs_id');
    });

    await connection.insert().into('test').values({ Text: 'witaj', Id: 1, belongs_id: 1 });
    await connection.insert().into('test').values({ Text: 'swiecie', Id: 2, belongs_id: 2 });

    await connection.schema().createTable('test2', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
      table.int('test_id');
    });

    
    await connection.schema().createTable('filterable', (table) => {
      table.int('Id').primaryKey().notNull().autoIncrement();
      table.string('Text', 32).notNull();
      table.int('Number');
    });


    await connection.insert().into('test2').values({ Text: 'hello', Id: 1, test_id: 1 });
    await connection.insert().into('test2').values({ Text: 'world', Id: 2, test_id: 2 });

    await connection.insert().into('test2').values({ Text: 'world', Id: 3, test_id: 1 });
    await connection.insert().into('test2').values({ Text: 'hello', Id: 4, test_id: 2 });

    await connection.insert().into('filterable').values({ Text: 'hello', Number: 1 });
    await connection.insert().into('filterable').values({ Text: 'hello1', Number: 2 });
    await connection.insert().into('filterable').values({ Text: 'hello2', Number: 3 });
    await connection.insert().into('filterable').values({ Text: 'hello3', Number: 4 });
    await connection.insert().into('filterable').values({ Text: 'hello4', Number: 5 });

  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

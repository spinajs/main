/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class Test_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('test', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Text', 32).notNull();
    });

    await connection.insert().into('test').values({ Text: 'witaj', Id: 1 });
    await connection.insert().into('test').values({ Text: 'swiecie', Id: 2 });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class Mutex_2024_12_03_11_41_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('__mutex__', (table) => {
      table.string('Name', 32).unique().primaryKey().notNull();
      table.string('Tenant', 32).notNull();
      table.boolean("Locked").notNull().default().value(0);
      table.dateTime('Created_at').notNull().default().dateTime();
      table.dateTime('Updated_at').notNull().default().dateTime();
    });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

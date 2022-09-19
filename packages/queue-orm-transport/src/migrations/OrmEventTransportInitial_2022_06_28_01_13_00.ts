/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('orm-event-transport')
export class OrmEventTransportInitial_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('orm_event_transport__event', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Channel', 32).notNull();
      table.dateTime('CreatedAt').default().dateTime();
      table.text('Value');
    });

    await connection.schema().createTable('orm_event_transport__subscribers', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name', 32).notNull().unique();
    });

    await connection.schema().createTable('orm_event_transport__queue', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('orm_event_transport__subscribers_Id');
      table.int('orm_event_transport__event_Id');

      table.boolean('Ack').default().value(0);
    });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

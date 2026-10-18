import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('orm-event-transport')
export class OrmEventTransportInitial_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('orm_event_transport__event', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Type').notNull();
      table.dateTime('CreatedAt').default().dateTime();
      table.text('Value');
    });

    await connection.schema().createTable('orm_event_transport__subscribers', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name', 32).notNull().unique();
      table.dateTime('LastAck').notNull().default().dateTime();
    });

    await connection.schema().createTable('orm_event_transport__queue', (table) => {
      table.int('orm_event_transport__subscribers_Id').notNull().primaryKey();
      table.int('orm_event_transport__event_Id').notNull().primaryKey();
      table.dateTime('Ack');
    });

    await connection.schema().createTable('orm_event_transport__job', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Type').notNull();
      table.text('Value').notNull();
      table.text('Result');
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('FinishedAt');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('orm_event_transport__job');
    await connection.schema().dropTable('orm_event_transport__queue');
    await connection.schema().dropTable('orm_event_transport__subscribers');
    await connection.schema().dropTable('orm_event_transport__event');
  }
}

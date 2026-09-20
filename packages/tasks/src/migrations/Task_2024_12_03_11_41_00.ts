/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration, RawQuery } from '@spinajs/orm';

@Migration('default')
export class Task_2024_12_03_11_41_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('__tasks', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name', 64).unique().notNull();
      table.string('Description', 128).notNull();
      table.enum('State', ['running', 'stopped']);
      table.dateTime('LastRunAt');
    });

    await connection.schema().createTable('__task_history', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('TaskId').notNull();
      table.text('Result');
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.int('Duration').default().value(0);
    });

    await connection.index().unique().table('__tasks').name('__tasks_unique_name').columns(['Name']);

    // if driver supports task scheduling
    // create orm task to clear old entries

    if (connection.supportedFeatures().events) {
      // The cutoff is computed by the engine on every run: a DateTime bound here would be
      // written into the event as a literal and stay frozen at migration time.
      await connection.schema().createEvent('__task_delete_old_entries', (event) => {
        event.every(1, 'DAY').do(new RawQuery('DELETE FROM `__task_history` WHERE `CreatedAt` < NOW() - INTERVAL 7 DAY'));
      });
    }
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

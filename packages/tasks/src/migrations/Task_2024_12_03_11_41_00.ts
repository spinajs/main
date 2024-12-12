/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';
import { __task_history } from '../models/__task_history.js';
import { DateTime } from 'luxon';

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
      // create periodical task
      // to clear old event entries
      // default value is 7 days old
      await connection
        .schema()
        .event('__task_delete_old_entries')
        .do(
          __task_history.destroy().where(
            'CreatedAt',
            '<',
            DateTime.now().plus({
              day: -7,
            }),
          ),
        );
    }
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

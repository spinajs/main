/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('queue')
export class Queue_2022_10_18_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('queue_jobs', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.uuid('JobId').notNull();
      table.string('Name', 32).notNull();
      table.string('Result');
      table.enum('Status', ['error', 'success', 'created', 'executing']).notNull().default().value('created');
      table.int('Progress').notNull().default().value(0);
      table.string('Connection').notNull();
      table.timestamp('CreatedAt').notNull().default().dateTime();
      table.timestamp('ExecutedAt');
      table.timestamp('FinishedAt');
    });

    await connection.index().unique().table('queue_jobs').name('queue_jobs_job_id').columns(['JobId']);
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

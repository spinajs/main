/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('queue')
export class Queue_2022_10_18_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('queue_jobs', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      // VARCHAR(36) spelled out, NOT `table.uuid(...)`.
      //
      // This line never changed - `uuid()` changed underneath it. It was an alias for
      // `string(name, 36)` from 2022-07-08 (`8d31b63b3`) until `3b4d40e06` ("Orm fixes 2", #104,
      // 2026-07-27) redefined it as `binary(name, 16)`. So every database created before that
      // commit has `queue_jobs.JobId varchar(36)` - the deployed ones do - and every database
      // created after it silently gets BINARY(16) instead.
      //
      // BINARY(16) only works for a column read and written through the UuidConverter, which packs
      // a dashed uuid into 16 bytes. `JobModel.JobId` carries no `@Uuid()` decorator and is a plain
      // `string` produced by `uuidv4()`, so on BINARY(16) the 36-character value is truncated on
      // insert and read back as a Buffer: `where({ JobId })` never matches, and the consumer cannot
      // find the row it just wrote. Same defect and same fix as `users.Uuid`.
      table.string('JobId', 36).notNull();
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

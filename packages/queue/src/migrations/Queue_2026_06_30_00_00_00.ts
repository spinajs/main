/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Adds retry / dead-letter bookkeeping to the jobs table, widens columns that were too small
 * and introduces the `queue_dead_letter` store used when a job exhausts its retry policy.
 */
@Migration('queue')
export class Queue_2026_06_30_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // retry / dead-letter bookkeeping on the existing jobs table ( ADD COLUMN works on all dialects )
    await connection.schema().alterTable('queue_jobs', (table) => {
      table.int('RetryCount').notNull().default().value(0);
      table.string('LastError', 1024);
      table.timestamp('DeadLetteredAt');
    });

    // widen the too-small columns. sqlite stores TEXT regardless of declared length and has no
    // MODIFY COLUMN, so only emit the in-place modification on dialects that support it.
    const isSqlite = connection.Options.Driver.toLowerCase().includes('sqlite');
    if (!isSqlite) {
      await connection.schema().alterTable('queue_jobs', (table) => {
        table.string('Name', 256).notNull().modify();
        table.text('Result').modify();
      });
    }

    // dead letter store - keeps full payload so messages can be requeued later
    await connection.schema().createTable('queue_dead_letter', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.uuid('JobId');
      table.string('Name', 256).notNull();
      table.string('Type', 16).notNull();
      table.string('Connection', 64).notNull();
      table.text('Payload');
      table.text('Error');
      table.int('RetryCount').notNull().default().value(0);
      table.timestamp('CreatedAt').notNull().default().dateTime();
      table.timestamp('FailedAt');
    });

    await connection.index().table('queue_dead_letter').name('queue_dead_letter_job_id').columns(['JobId']);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

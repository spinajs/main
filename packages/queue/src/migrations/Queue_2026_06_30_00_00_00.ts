/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Adds the `Attempt` column to `queue_jobs` so failed job runs can be counted
 * and jobs can be marked `retrying` / `dead` once they exceed their RetryCount.
 */
@Migration('queue')
export class Queue_2026_06_30_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('queue_jobs', (table) => {
      table.int('Attempt').notNull().default().value(0);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

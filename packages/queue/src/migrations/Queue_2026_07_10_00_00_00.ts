/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Adds nullable `Phase` and `Message` columns to `queue_jobs` so jobs can report
 * richer progress (a phase label and message) alongside the numeric percentage.
 */
@Migration('queue')
export class Queue_2026_07_10_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('queue_jobs', (table) => {
      // nullable by default (no notNull) - only set by jobs that report richer progress
      table.string('Phase', 32);
      table.string('Message', 512);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

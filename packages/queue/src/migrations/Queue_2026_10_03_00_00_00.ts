/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Adds nullable `InitiatorType` and `InitiatorId` columns to `queue_jobs`: who emitted the job,
 * copied from `message.Initiator` when the consumer first sees it. Null for jobs emitted
 * without a principal and for rows written before this migration.
 */
@Migration('queue')
export class Queue_2026_10_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('queue_jobs', (table) => {
      table.string('InitiatorType', 32);
      table.string('InitiatorId', 255);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

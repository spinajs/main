/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Turns `queue_jobs.Status` back into `varchar(32)`. Queue_2026_07_17 re-declared it as a fixed
 * ENUM, undoing Queue_2026_07_02, whose plain string keeps future statuses valid on every dialect.
 * NOT NULL and the 'created' default are restated because MySQL's MODIFY COLUMN drops anything omitted.
 */
@Migration('queue')
export class Queue_2026_10_17_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // sqlite has no MODIFY COLUMN and already stores Status as unconstrained TEXT
    const isSqlite = connection.Options.Driver.toLowerCase().includes('sqlite');
    if (isSqlite) {
      return;
    }

    await connection.schema().alterTable('queue_jobs', (table) => {
      const status = table.string('Status', 32).notNull();
      status.default().value('created');
      status.modify();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Hardens the `queue_jobs` schema:
 *  - adds LastError ( errors no longer stuffed into Result ), MaxAttempts and UpdatedAt
 *  - converts Status from a fixed ENUM to a plain string so `retrying` / `dead` ( and future
 *    statuses ) are valid on all dialects ( the ENUM previously rejected them on MySQL/MSSQL )
 *  - widens the too-small Name and Result columns
 *  - indexes (Status, CreatedAt) to support retention purge and monitoring queries
 */
@Migration('queue')
export class Queue_2026_07_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // additive columns work on every dialect
    await connection.schema().alterTable('queue_jobs', (table) => {
      table.string('LastError', 1024);
      table.int('MaxAttempts').notNull().default().value(0);
      table.timestamp('UpdatedAt');
    });

    // sqlite stores TEXT regardless of declared type/length and has no MODIFY COLUMN, so the
    // conversions below are only needed ( and only valid ) on dialects that enforce column types.
    const isSqlite = connection.Options.Driver.toLowerCase().includes('sqlite');
    if (!isSqlite) {
      await connection.schema().alterTable('queue_jobs', (table) => {
        // MySQL's MODIFY COLUMN replaces the whole definition and silently drops anything
        // omitted, so the 'created' default must be restated or it is lost. `.default().value()`
        // returns the ColumnQueryBuilder (no `.modify()`), so `.modify()` is called separately
        // on the column builder itself ( mirrors the pattern in Queue_2026_07_17 ).
        const status = table.string('Status', 32).notNull();
        status.default().value('created');
        status.modify();
        table.string('Name', 256).notNull().modify();
        table.text('Result').modify();
      });
    }

    await connection.index().table('queue_jobs').name('queue_jobs_status_created').columns(['Status', 'CreatedAt']);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

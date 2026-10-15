/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Lock expiry as epoch ms. An integer, not a datetime, because the datetime converter
 * stores local time without an offset and SQLite compares datetimes as text.
 */
@Migration('default')
export class Mutex_2026_10_15_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.bigint('LockedUntil');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

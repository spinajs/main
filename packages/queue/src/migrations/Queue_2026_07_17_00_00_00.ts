/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Widens `queue_jobs.Status` to the six states the code actually writes.
 * `retrying` / `dead` arrived with retry support (see index.ts) but the enum
 * was never widened, so strict-enum drivers reject or coerce them.
 *
 * NOT NULL and the 'created' default are restated deliberately: MySQL's MODIFY
 * COLUMN replaces the whole definition and silently drops anything omitted.
 * On sqlite this alteration is a logged no-op - it renders enum as
 * unconstrained TEXT, so there is nothing to widen there.
 */
@Migration('queue')
export class Queue_2026_07_17_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // sqlite renders enum as unconstrained TEXT and has no MODIFY COLUMN, so there is
    // nothing to widen there. Emitting the MODIFY anyway produces a MySQL-flavoured
    // `ALTER TABLE ... MODIFY ... ENUM(...)` that sqlite rejects, so skip it explicitly
    // ( mirrors the guard in Queue_2026_07_02, and matches this migration's documented
    // "no-op on sqlite" contract above ).
    const isSqlite = connection.Options.Driver.toLowerCase().includes('sqlite');
    if (isSqlite) {
      return;
    }

    await connection.schema().alterTable('queue_jobs', (table) => {
      // `.default().value('created')` returns the ColumnQueryBuilder, which has no
      // `.modify()` - that lives on AlterColumnQueryBuilder. So `.modify()` must be
      // called on the column builder itself, separately from the default.
      const status = table.enum('Status', ['error', 'success', 'created', 'executing', 'retrying', 'dead']).notNull();
      status.default().value('created');
      status.modify();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

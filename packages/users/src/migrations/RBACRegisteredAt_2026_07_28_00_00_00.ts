/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Adds the missing `RegisteredAt` column to `users`.
 *
 * `UserBase.RegisteredAt` has been declared on the model — and stamped by the
 * `create()` action — since the beginning, but the initial migration never
 * created the column. The ORM writes only columns the table description
 * actually reports, so the value was dropped on every insert without a word:
 * the field read back as null forever and anything distinguishing "account
 * created" from "registration completed" quietly did not work.
 *
 * Nullable on purpose. Existing rows genuinely have no registration instant to
 * backfill with, and inventing one ( CreatedAt, say ) would assert that every
 * account that predates this migration completed registration, which is exactly
 * the claim the column exists to make.
 */
@Migration('default')
export class RBACRegisteredAt_2026_07_28_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // Applications that hit this gap already have added the column by hand;
    // running ALTER TABLE against them would fail the whole migration on
    // startup. Checked rather than assumed, because a migration that can only
    // run on a pristine database is a migration that strands everybody who
    // worked around the bug.
    const columns = await connection.tableInfo('users');

    if (columns?.some((c) => c.Name === 'RegisteredAt')) {
      return;
    }

    await connection.schema().alterTable('users', (table) => {
      table.dateTime('RegisteredAt');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

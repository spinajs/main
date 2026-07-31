import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';
import { columnNativeType, isMySqlDialect } from '../migration-support.js';

/**
 * Widens `user_sessions.CreatedAt` / `Expiration` from `date` to `datetime`.
 *
 * !! This is a correctness fix in its own right and has nothing to do with the
 * JSON conversion it used to be bundled with. It is a separate migration
 * precisely so it can be applied, skipped, reviewed and reverted on its own.
 *
 * The bug
 * -------
 * A MySQL `date` column stores only the calendar day - MySQL truncates the time
 * component on write, silently:
 *
 *     INSERT INTO probe VALUES ('2026-07-31 23:45:12', '2026-07-31 23:45:12');
 *     asDate       asDateTime
 *     2026-07-31   2026-07-31 23:45:12
 *
 * So on a deployed database a session's `Expiration` has no time of day: a
 * session created at 23:45 with a 60-minute sliding TTL, due to expire at
 * 00:45:12, is stored as expiring at 00:00:00 and the cleanup sweep kills it
 * ~45 minutes early. Sliding expiration, `SessionProvider.isExpired`,
 * `cleanupExpired` and `touch` all operate on that truncated value. `DbSession`
 * declares both fields as luxon `DateTime` and the create path has declared both
 * as `dateTime` since 2024; `datetime` is the type the code has always assumed
 * it had.
 *
 * Why this one is safe where the JSON one was not
 * -----------------------------------------------
 * `date -> datetime` is a WIDENING cast. Every existing value is representable
 * in the target type (midnight of the stored day), so unlike the `text -> json`
 * conversion it cannot fail on row content and needs no wipe. Nothing is
 * deleted here.
 *
 * Guards mirror the JSON migration: skip when the table is absent, skip unless
 * `CreatedAt` is currently exactly `date`, skip on any non-MySQL dialect
 * (`MODIFY` is MySQL syntax; a failed migration at boot bricks every later
 * migration on the connection through `assertNoFailed()`). `CreatedAt` alone is
 * probed - the two columns were created by the same statement in every database
 * that has the old shape, and a `date`/`datetime` split between them has never
 * existed.
 *
 * ONE statement with two `MODIFY` clauses, via the raw escape hatch, rather than
 * `alterTable()`: the builder compiles one statement per column and
 * `SqlDriver.execute` runs them through `Promise.all`, i.e. two concurrent
 * `ALTER TABLE`s on the same table from two pooled connections.
 *
 * Nullability is restated verbatim from the create path - `MODIFY` replaces the
 * whole column definition, and `CreatedAt` is `notNull()` there while
 * `Expiration` is nullable (a never-expiring session persists a NULL).
 */
@Migration('session-provider-connection')
export class UserSessionTimestamps_2026_07_31_00_00_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists('user_sessions'))) {
      return;
    }

    const createdAtType = await columnNativeType(connection, 'user_sessions', 'CreatedAt');

    // Only the one known-bad state is converted. `datetime` is the target,
    // `timestamp` needs no help, `null` means the probe could not read the
    // table, and anything else is a shape this migration was not written for.
    if (createdAtType !== 'date' || !isMySqlDialect(connection)) {
      return;
    }

    await connection.schema().raw('ALTER TABLE `user_sessions` MODIFY `CreatedAt` DATETIME NOT NULL, MODIFY `Expiration` DATETIME');
  }

  /**
   * Deliberately a no-op, and this is a decision rather than an omission.
   *
   * `up()` widened `date -> datetime`. Reversing it would be a NARROWING cast
   * that silently truncates the time-of-day off every stored row - it destroys
   * data, and it re-introduces the exact expiry bug this migration exists to
   * fix, on a schema whose model and create path have declared `dateTime` for
   * years. A `datetime` column is also perfectly readable by every version of
   * this package, so a rollback has nothing to gain from shrinking it.
   *
   * (The JSON migration's `down()` is implemented, because there the old readers
   * genuinely cannot cope with the new column type. That is not the case here.)
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

/**
 * Converges an EXISTING `user_sessions` table onto the types the create-path
 * migration (`UserSessionDBSqlMigration_2022_06_28_01_20_00`) declares.
 *
 * Databases created before that migration existed - i.e. every deployment -
 * carry `Data text NOT NULL`, `CreatedAt date NOT NULL` and `Expiration date`.
 * The create migration returns early when the table is already there, so the
 * types it declares have never reached them. Fresh installs get `json` /
 * `datetime` / `datetime`. Two shapes of the same table exist in the wild and
 * nothing detected which one you had; this migration ends that.
 *
 * `Data` becomes JSON
 * -------------------
 * JSON is the intended storage type. mysql2 parses a json column on the way out,
 * so the read path receives the payload as a live object graph and rebuilds the
 * session `Map` from it directly instead of re-parsing text
 * (`decodeSessionData`). The write path is unchanged - `encodeSessionData` still
 * produces JSON text, which a json column stores verbatim.
 *
 * `CreatedAt` / `Expiration` become DATETIME
 * ------------------------------------------
 * !! This half fixes a real, separate correctness bug and is worth reviewing on
 * its own. A MySQL `date` column stores only the calendar day: MySQL truncates
 * the time component on write, silently. On a deployed database a session's
 * `Expiration` therefore has NO time of day, so sliding expiration, the cleanup
 * sweep and every `Expiration <= now()` comparison operate at DAY granularity -
 * a session can outlive its TTL by up to a day, or die early. `DbSession`
 * declares both as luxon `DateTime` and the create path declares both as
 * `dateTime`, so `datetime` is the type the code has always assumed.
 *
 * Why the wipe
 * ------------
 * Sessions are disposable state: the worst a user sees is one forced re-login.
 * Converting a text column that holds arbitrary rows into a json column is NOT
 * disposable - MySQL validates every existing row during the ALTER, and a single
 * malformed / truncated / empty payload (a row from a crashed write, a row
 * written by an older codec, a row truncated by TEXT's 64 KiB limit) fails the
 * statement and takes the whole startup migration down with it. Emptying the
 * table first makes the conversion unconditionally safe and costs a login.
 * `DELETE`, not `TRUNCATE`: truncate is not transactional, is refused outright
 * by some engines for a table involved in foreign keys, and there is no volume
 * here to make it worth the difference.
 *
 * Idempotent by construction
 * --------------------------
 * On a fresh install the table is already `json` / `datetime` / `datetime` and
 * this migration still runs, right after the create path, in the same startup.
 * That is fine and deliberate: `DELETE` over an empty table removes nothing, and
 * MySQL's `MODIFY` to the type a column already has is a plain table rewrite
 * with no conversion and no error. Re-running it can therefore never fail, which
 * is what lets it be unconditional rather than guarded by a type probe that
 * would have to reproduce every dialect's spelling of "json".
 *
 * sqlite is a deliberate no-op: it has no `MODIFY`, and its own alter-column
 * compiler compiles a modify to nothing (it is dynamically typed, so a type
 * change carries no meaning there). The `DELETE` still runs.
 */
@Migration('session-provider-connection')
export class UserSessionDataJson_2026_07_31_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // Nothing to converge if the table is not there. It normally IS - the create
    // migration carries an earlier timestamp and runs first in the same batch -
    // but a connection that only hosts part of the schema must not blow up here.
    if (!(await connection.schema().tableExists('user_sessions'))) {
      return;
    }

    // Unquoted on purpose: `user_sessions` needs no quoting in any dialect, and a
    // backtick-quoted literal would be rejected by MSSQL.
    await connection.schema().raw('DELETE FROM user_sessions');

    await connection.schema().alterTable('user_sessions', (table) => {
      // MODIFY replaces the whole column definition, so every attribute that must
      // survive has to be restated - omitting `notNull` would silently make the
      // column nullable.
      table.json('Data').notNull().modify();
      table.dateTime('CreatedAt').notNull().modify();

      // nullable on purpose - a never-expiring session persists a NULL Expiration
      table.dateTime('Expiration').modify();
    });
  }

  // Not reversible in any useful sense: the sessions this migration deletes are
  // gone, and restoring `date` columns would reintroduce the day-granularity bug.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}

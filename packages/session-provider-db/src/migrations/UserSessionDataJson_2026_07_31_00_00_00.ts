import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';
import { columnNativeType, isMySqlDialect, isTextFamily } from '../migration-support.js';

/**
 * Converts an EXISTING text-typed `user_sessions.Data` to a native MySQL `json`
 * column, so the read path receives a parsed object graph instead of text.
 *
 * Databases created before the create-path migration
 * (`UserSessionDBSqlMigration_2022_06_28_01_20_00`) declared `json` - i.e. every
 * deployment - carry `Data text NOT NULL`. The create migration returns early
 * when the table is already there, so the type it declares has never reached
 * them. Fresh installs already get `json`. Two shapes of the same table exist in
 * the wild and nothing detected which one you had; this migration ends that.
 *
 * mysql2 parses a json column on the way out, so the read path receives the
 * payload as a live object graph and rebuilds the session `Map` from it directly
 * (`decodeSessionData`). The write path is unchanged - `encodeSessionData` still
 * produces JSON text, which a json column stores verbatim.
 *
 * Everything below is a guard. Read them in order.
 *
 * 1. Table missing: nothing to converge
 * ---------------------------------------
 * It normally IS there - the create migration carries an earlier timestamp and
 * runs first in the same batch - but a connection that hosts only part of the
 * schema must not blow up here.
 *
 * 2. Column state probe: skip unless it is text-family
 * ------------------------------------------------------
 * The previous version of this migration was unconditional, on the argument that
 * `MODIFY` to a type a column already has is a harmless rewrite. True on MySQL,
 * and irrelevant everywhere else: it reached the schema builder's `alterTable()`,
 * which resolves `AlterTableQueryCompiler` - and `orm-mssql` registers no
 * implementation for it, so DI hands back the ABSTRACT class, whose `compile()`
 * does not exist. That throw is recorded as a FAILED migration, and
 * `assertNoFailed()` then refuses to run ANY migration on that connection ever
 * again: the application never boots without manual surgery on the tracking
 * table. Probing the target state first and returning early is the same shape
 * `@spinajs/rbac`'s `RBACRegisteredAt_2026_07_28_00_00_00` already uses, and it
 * makes the no-op case genuinely free rather than merely survivable.
 *
 * An unreadable probe skips too - see `columnNativeType`.
 *
 * 3. Dialect gate: MySQL only
 * ------------------------------
 * `MODIFY` and the `JSON` type are MySQL's. A text-family `Data` on MSSQL
 * (`nvarchar`) or sqlite (`TEXT`) passes guard 2 and would then be handed
 * syntax its server rejects - the same failed-migration outage guard 2 exists to
 * prevent. Those dialects keep a text column and the read path keeps decoding a
 * string, which is exactly what `decodeSessionData` does with it.
 *
 * 4. The wipe
 * -----------
 * Reached only when an actual `text -> json` conversion is about to happen.
 * MySQL validates EVERY existing row during that conversion, and a single
 * malformed / truncated / empty payload (a row from a crashed write, a row
 * written by an older codec, a row truncated by TEXT's 64 KiB limit) fails the
 * statement:
 *
 *     ERROR 3140 (22032): Invalid JSON text: "Invalid value." at position 1
 *
 * Emptying the table first makes the conversion unconditionally safe. Sessions
 * are disposable state: the worst a user sees is one forced re-login, and that
 * is now paid ONLY by the deployments actually being converted - a fresh install
 * skips at guard 2 and never deletes anything.
 *
 * `DELETE`, not `TRUNCATE`: truncate is not transactional, is refused outright
 * by some engines for a table involved in foreign keys, and there is no volume
 * here to make the difference worth having.
 *
 * 5. ONE statement, not three
 * ----------------------------
 * `alterTable()` compiles one `ICompilerOutput` per modified column and
 * `SqlDriver.execute` wraps the array in `Promise.all` - three concurrent
 * `ALTER TABLE`s on three pooled connections against one table. A partial
 * failure leaves the table half-converted AND the migration marked failed. The
 * raw escape hatch (`schema().raw`, compiled by `SqlRawSchemaQueryCompiler`,
 * registered by every SQL driver via `orm-sql`) sends exactly one statement.
 * The `CreatedAt`/`Expiration` widening that used to ride along here now lives
 * in its own migration (`UserSessionTimestamps_2026_07_31_00_00_01`), because it
 * is a cast that cannot fail and must stay independently applicable.
 */
@Migration('session-provider-connection')
export class UserSessionDataJson_2026_07_31_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists('user_sessions'))) {
      return;
    }

    const dataType = await columnNativeType(connection, 'user_sessions', 'Data');

    // already `json` (fresh install / already converged), unreadable, or a type
    // nobody anticipated - all three mean "leave it alone"
    if (dataType === null || !isTextFamily(dataType)) {
      return;
    }

    if (!isMySqlDialect(connection)) {
      return;
    }

    await connection.schema().raw('DELETE FROM user_sessions');

    // Identifiers are backtick-quoted: this statement is MySQL-only by
    // construction (guard 3), so portability of the quoting style is not a
    // constraint, and quoting removes any question about `Data` being a MySQL
    // keyword. `NOT NULL` is restated because MODIFY replaces the WHOLE column
    // definition - omitting it would silently make the column nullable.
    await connection.schema().raw('ALTER TABLE `user_sessions` MODIFY `Data` JSON NOT NULL');
  }

  /**
   * Restores the text column. The sessions `up()` deleted are gone for good -
   * that part is not reversible and nothing pretends otherwise - but the SHAPE
   * is, and a package rollback that leaves a `json` column behind for a
   * `2.0.488` reader is its own outage.
   *
   * Guarded by the inverse probe: only a column that is currently `json` is
   * touched, so running `down()` twice, or against a database this migration
   * never converted, does nothing.
   *
   * `TEXT` because `TEXT` is what the deployed databases had. Note this is a
   * NARROWING cast - a stored payload above TEXT's 64 KiB limit would fail the
   * statement in strict mode. That is acceptable here in a way it would not be
   * in `up()`: `down()` runs only on an explicit, interactive rollback, never at
   * boot, so a failure is loud and immediate rather than an unbootable service.
   */
  public async down(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists('user_sessions'))) {
      return;
    }

    const dataType = await columnNativeType(connection, 'user_sessions', 'Data');

    if (dataType !== 'json' || !isMySqlDialect(connection)) {
      return;
    }

    await connection.schema().raw('ALTER TABLE `user_sessions` MODIFY `Data` TEXT NOT NULL');
  }
}

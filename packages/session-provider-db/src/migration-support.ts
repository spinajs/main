import { OrmDriver } from '@spinajs/orm';

/**
 * Shared probes for the converging migrations in `./migrations`.
 *
 * Lives OUTSIDE `src/migrations` on purpose: `MigrationSource` globs that
 * directory and imports every `.js` it finds, and a module that is not a
 * migration has no business being pulled into that scan.
 */

/**
 * Driver names (the `@Injectable(...)` keys the mysql package registers, which
 * is what `db.Connections[n].Driver` carries) whose dialect understands
 * `ALTER TABLE ... MODIFY <col> <type>` and has a native `JSON` column type.
 *
 * This gate is not decoration. `MODIFY` is MySQL/MariaDB syntax - MSSQL spells
 * it `ALTER COLUMN` and has no `JSON` type at all, sqlite has neither - so
 * emitting the statement anywhere else is a syntax error, i.e. a FAILED
 * migration, i.e. `assertNoFailed()` blocking every future migration on that
 * connection. Every other dialect stores the payload as text and the read path
 * (`decodeSessionData`) already handles the string shape, so skipping there is
 * not a compromise: there is genuinely nothing to converge.
 */
const MYSQL_DRIVERS = ['orm-driver-mysql', 'orm-driver-mysql-ssh'];

/**
 * The text-family native types a legacy `user_sessions.Data` can carry. A
 * column of any of these is the state the JSON conversion exists to fix;
 * anything else (`json` on a converged or fresh database, or something nobody
 * anticipated) is left alone.
 */
const TEXT_FAMILY = ['text', 'tinytext', 'mediumtext', 'longtext', 'varchar', 'nvarchar'];

/**
 * True when the connection speaks MySQL's DDL dialect. See {@link MYSQL_DRIVERS}.
 *
 * @param connection - the migration's connection
 */
export function isMySqlDialect(connection: OrmDriver): boolean {
  return MYSQL_DRIVERS.includes(connection.Options?.Driver);
}

/**
 * Reduces a driver-reported `NativeType` to its bare type name, lower-cased.
 *
 * `IColumnDescriptor.NativeType` is documented as the FULL database type - MySQL
 * reports `information_schema.DATA_TYPE` (already bare: `varchar`, `text`,
 * `json`, `date`), but sqlite reports the declared type verbatim, so
 * `VARCHAR(36)` and `INT(10) UNSIGNED` both occur. Comparing raw strings would
 * therefore miss exactly the databases the probe exists to recognise.
 *
 * @param nativeType - whatever the driver reported
 */
export function normalizeNativeType(nativeType: string): string {
  return String(nativeType).toLowerCase().split('(')[0].trim().split(/\s+/)[0];
}

/**
 * True when the (normalized) type is one of the text-family types listed in
 * {@link TEXT_FAMILY}.
 *
 * @param nativeType - a type name, normalized or not
 */
export function isTextFamily(nativeType: string): boolean {
  return TEXT_FAMILY.includes(normalizeNativeType(nativeType));
}

/**
 * Normalized native type of one column, or `null` when it cannot be established.
 *
 * `null` means "do not touch anything": the table is not described, the column
 * is absent, or the driver's `tableInfo()` refused/failed. A migration that
 * cannot see the current state must SKIP, never guess - a throw here would be
 * recorded as a failed migration, and `assertNoFailed()` then blocks every
 * subsequent migration on that connection until somebody edits the tracking
 * table by hand. On a service that migrates at boot that is an outage, and the
 * thing being probed is a type conversion nobody is waiting for.
 *
 * @param connection - the migration's connection
 * @param table - table name
 * @param column - column name, compared case-insensitively
 */
export async function columnNativeType(connection: OrmDriver, table: string, column: string): Promise<string | null> {
  let columns;

  try {
    columns = await connection.tableInfo(table);
  } catch {
    // e.g. the mysql driver throws when the connection carries no Database, and
    // a driver may not implement tableInfo usefully at all.
    return null;
  }

  const found = columns?.find((c) => c.Name?.toLowerCase() === column.toLowerCase());

  if (!found?.NativeType) {
    return null;
  }

  return normalizeNativeType(found.NativeType);
}

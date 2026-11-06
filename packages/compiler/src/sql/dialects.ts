import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SqlDialect = 'postgresql' | 'mysql' | 'sqlite' | 'transactsql';
export const SQL_DIALECTS: readonly SqlDialect[] = ['postgresql', 'mysql', 'sqlite', 'transactsql'];

const DRIVER_DIALECTS = new Map<string, SqlDialect>([
  ['orm-driver-postgres', 'postgresql'],
  ['orm-driver-pglite', 'postgresql'],
  ['orm-driver-mysql', 'mysql'],
  ['orm-driver-sqlite', 'sqlite'],
  ['orm-driver-mssql', 'transactsql'],
]);

export const isSqlDialect = (value: unknown): value is SqlDialect => typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);

/** The dialect of a `db.Connections[].Driver` token of the SpinaJS ORM drivers. */
export function dialectOfDriver(driver: string): SqlDialect | undefined {
  return DRIVER_DIALECTS.get(driver);
}

/** `package.json#spinajs.orm.dialects` of the app (D6): connection name to dialect; unknown names are dropped. */
export function readSqlDialects(appRoot: string): Record<string, SqlDialect> {
  const file = join(appRoot, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { spinajs?: { orm?: { dialects?: Record<string, unknown> } } };
    return Object.fromEntries(Object.entries(pkg.spinajs?.orm?.dialects ?? {}).filter((e): e is [string, SqlDialect] => isSqlDialect(e[1])));
  } catch {
    return {};
  }
}

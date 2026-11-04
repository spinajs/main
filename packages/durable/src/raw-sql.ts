import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';

export type SqlDialect = 'sqlite' | 'mysql' | 'postgres';

// executeOnDb lives on orm-sql's SqlDriver, not on the OrmDriver contract
export type RawSqlDriver = OrmDriver & {
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown>;
};

/**
 * Raw statements were written and tested for these dialects only; any other driver (e.g. MSSQL) is
 * refused rather than given statements with untested quoting and row counts.
 * `what` names the statements and `owner` the package in the error message.
 */
export function sqlDialect(driverName: string, what: string, owner = 'durable'): SqlDialect {
  const d = driverName.toLowerCase();
  if (d.includes('sqlite')) return 'sqlite';
  if (d.includes('mysql')) return 'mysql';
  if (d.includes('postgres')) return 'postgres';
  throw new InvalidOperation(`${owner}: no ${what} for driver '${driverName}'`);
}

export function quoteFor(dialect: SqlDialect): (identifier: string) => string {
  return dialect === 'mysql' ? (id) => `\`${id}\`` : (id) => `"${id}"`;
}

export async function defaultSqlDriver(owner = 'durable'): Promise<RawSqlDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get('default') as RawSqlDriver | undefined;
  if (!driver) throw new InvalidOperation(`${owner}: ORM connection "default" not found`);
  return driver;
}

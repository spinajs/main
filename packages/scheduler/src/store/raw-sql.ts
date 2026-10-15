import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';

export type SqlDialect = 'sqlite' | 'mysql' | 'postgres';

// executeOnDb lives on orm-sql's SqlDriver, not on the OrmDriver contract
export type RawSqlDriver = OrmDriver & {
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown>;
};

/**
 * The scheduler's raw statements were written and tested for these dialects only; any other driver
 * (e.g. MSSQL) is refused rather than given statements with untested quoting and row counts.
 * `what` names the statements in the error message.
 */
export function sqlDialect(driverName: string, what: string): SqlDialect {
  const d = driverName.toLowerCase();
  if (d.includes('sqlite')) return 'sqlite';
  if (d.includes('mysql')) return 'mysql';
  if (d.includes('postgres')) return 'postgres';
  throw new InvalidOperation(`scheduler: no ${what} for driver '${driverName}'`);
}

export function quoteFor(dialect: SqlDialect): (identifier: string) => string {
  return dialect === 'mysql' ? (id) => `\`${id}\`` : (id) => `"${id}"`;
}

/** The connection every scheduler model uses (`@Connection('default')`). */
export async function defaultSqlDriver(): Promise<RawSqlDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get('default') as RawSqlDriver | undefined;
  if (!driver) throw new InvalidOperation('scheduler: ORM connection "default" not found');
  return driver;
}

export interface CounterSql {
  quote: (identifier: string) => string;
  /** Runs an UPDATE and returns the number of matched rows (see LeaseStore on MySQL found rows). */
  update: (stmt: string, params: unknown[]) => Promise<number>;
}

/**
 * For what the query builder cannot express: in-place increments (`SET col = col + 1`), which stay
 * correct when several replicas update one row.
 * Never put a literal `?` in a statement: the Postgres driver turns every `?` into a placeholder.
 */
export async function counterSql(): Promise<CounterSql> {
  const driver = await defaultSqlDriver();
  return {
    quote: quoteFor(sqlDialect(driver.Options.Driver, 'counter statements')),
    update: async (stmt, params) => {
      const r = (await driver.executeOnDb(stmt, params, QueryContext.Update)) as { RowsAffected?: number };
      return r?.RowsAffected ?? 0;
    },
  };
}

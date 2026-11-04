import { defaultSqlDriver as durableDefaultSqlDriver, quoteFor, sqlDialect as durableSqlDialect, type RawSqlDriver, type SqlDialect } from '@spinajs/durable';
import { QueryContext } from '@spinajs/orm';

export { quoteFor };
export type { RawSqlDriver, SqlDialect };

export function sqlDialect(driverName: string, what: string): SqlDialect {
  return durableSqlDialect(driverName, what, 'scheduler');
}

/** The connection every scheduler model uses (`@Connection('default')`). */
export function defaultSqlDriver(): Promise<RawSqlDriver> {
  return durableDefaultSqlDriver('scheduler');
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

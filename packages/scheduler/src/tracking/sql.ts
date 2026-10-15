import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';

// executeOnDb lives on orm-sql's SqlDriver, not on the OrmDriver contract
interface RawSqlDriver {
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown>;
}

export interface CounterSql {
  quote: (identifier: string) => string;
  /** Runs an UPDATE and returns the number of matched rows (see LeaseStore on MySQL found rows). */
  update: (stmt: string, params: unknown[]) => Promise<number>;
}

/**
 * Raw statements on the scheduler's connection for what the query builder cannot express:
 * in-place increments (`SET col = col + 1`), which stay correct when several replicas update one row.
 * Never put a literal `?` in a statement: the Postgres driver turns every `?` into a placeholder.
 */
export async function counterSql(): Promise<CounterSql> {
  const driver = (await DI.resolve(Orm)).Connections.get('default') as (OrmDriver & RawSqlDriver) | undefined;
  if (!driver) throw new InvalidOperation('scheduler: ORM connection "default" not found');
  const mysql = driver.Options.Driver.toLowerCase().includes('mysql');
  return {
    quote: (id) => (mysql ? `\`${id}\`` : `"${id}"`),
    update: async (stmt, params) => {
      const r = (await driver.executeOnDb(stmt, params, QueryContext.Update)) as { RowsAffected?: number };
      return r?.RowsAffected ?? 0;
    },
  };
}

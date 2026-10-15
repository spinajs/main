import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, QueryContext } from '@spinajs/orm';
import { DbTimeSource } from './clock.js';

export function dbNowSql(driverName: string): string {
  const d = driverName.toLowerCase();
  if (d.includes('sqlite')) return "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS ms";
  // UTC_TIMESTAMP, not UNIX_TIMESTAMP(NOW()): mapping a session-local time back to epoch is off by
  // an hour inside a repeated DST hour of the session time zone
  if (d.includes('mysql'))
    return "SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS ms";
  // clock_timestamp(), not now(): now() is frozen at the start of the transaction
  if (d.includes('postgres')) return 'SELECT CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) AS ms';
  throw new InvalidOperation(`scheduler: no database time query for driver '${driverName}'`);
}

interface RawSqlDriver {
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown>;
}

@Injectable(DbTimeSource)
export class SqlDbTimeSource extends DbTimeSource {
  public async read(): Promise<number> {
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('default');
    if (!driver) throw new InvalidOperation('scheduler: ORM connection "default" not found');
    // executeOnDb lives on orm-sql's SqlDriver, not on the OrmDriver contract
    const rows = (await (driver as unknown as RawSqlDriver).executeOnDb(
      dbNowSql(driver.Options.Driver),
      [],
      QueryContext.Select,
    )) as Array<{ ms: number | string }>;
    return Number(rows[0].ms);
  }
}

import { Injectable } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { defaultSqlDriver, sqlDialect } from '../store/raw-sql.js';
import { DbTimeSource } from './clock.js';

export function dbNowSql(driverName: string): string {
  switch (sqlDialect(driverName, 'database time query')) {
    case 'sqlite':
      return "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS ms";
    // UTC_TIMESTAMP, not UNIX_TIMESTAMP(NOW()): mapping a session-local time back to epoch is off by
    // an hour inside a repeated DST hour of the session time zone
    case 'mysql':
      return "SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS ms";
    // clock_timestamp(), not now(): now() is frozen at the start of the transaction
    case 'postgres':
      return 'SELECT CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) AS ms';
  }
}

@Injectable(DbTimeSource)
export class SqlDbTimeSource extends DbTimeSource {
  public async read(): Promise<number> {
    const driver = await defaultSqlDriver();
    const rows = (await driver.executeOnDb(dbNowSql(driver.Options.Driver), [], QueryContext.Select)) as Array<{
      ms: number | string;
    }>;
    return Number(rows[0].ms);
  }
}

import { OrmDriver, QueryContext } from '@spinajs/orm';

const MYSQL_NOW_MS = "SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000 AS now_ms";

const NOW_MS_SQL: Record<string, string> = {
  'orm-driver-sqlite': "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now_ms",
  // UTC_TIMESTAMP and a DATETIME literal: no session time zone conversion, no DST ambiguity
  'orm-driver-mysql': MYSQL_NOW_MS,
  'orm-driver-mysql-ssh': MYSQL_NOW_MS,
  // clock_timestamp(), not now(): now() is frozen at transaction start
  'orm-driver-postgres': 'SELECT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) AS now_ms',
};

/**
 * Current time in epoch ms from the database clock, so replicas with skewed clocks agree
 * on lock expiry. Drivers without a known expression fall back to the app clock.
 */
export async function dbNowMs(driver: OrmDriver): Promise<number> {
  const sql = NOW_MS_SQL[driver?.Options?.Driver as string];
  const raw = driver as unknown as { executeOnDb?: (stmt: string, params: unknown[], context: QueryContext) => Promise<any> };

  if (!sql || typeof raw.executeOnDb !== 'function') {
    return Date.now();
  }

  const rows = await raw.executeOnDb(sql, [], QueryContext.Select);

  // pg and mysql2 may return BIGINT as a string
  return Number(rows[0].now_ms);
}

import { Injectable } from '@spinajs/di';
import { executeSql, sql, SqlExpressions } from '@spinajs/orm';
import { defaultSqlDriver } from './raw-sql.js';
import { DbTimeSource } from './clock.js';

@Injectable(DbTimeSource)
export class SqlDbTimeSource extends DbTimeSource {
  public async read(): Promise<number> {
    const driver = await defaultSqlDriver();
    const epochMillis = driver.Container.resolve(SqlExpressions).epochMillis();
    const [row] = await executeSql<{ ms: number | string }>(sql`SELECT ${sql.raw(epochMillis)} AS ms`);
    return Number(row.ms);
  }
}

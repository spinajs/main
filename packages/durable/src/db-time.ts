import { Injectable } from '@spinajs/di';
import { QueryContext, SqlExpressions } from '@spinajs/orm';
import { defaultSqlDriver } from './raw-sql.js';
import { DbTimeSource } from './clock.js';

@Injectable(DbTimeSource)
export class SqlDbTimeSource extends DbTimeSource {
  public async read(): Promise<number> {
    const driver = await defaultSqlDriver();
    const epochMillis = driver.Container.resolve(SqlExpressions).epochMillis();
    const rows = (await driver.executeOnDb(`SELECT ${epochMillis} AS ms`, [], QueryContext.Select)) as Array<{ ms: number | string }>;
    return Number(rows[0].ms);
  }
}

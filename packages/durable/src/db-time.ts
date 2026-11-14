import { Injectable } from '@spinajs/di';
import { defaultSqlDriver } from './raw-sql.js';
import { DbTimeSource } from './clock.js';

@Injectable(DbTimeSource)
export class SqlDbTimeSource extends DbTimeSource {
  public async read(): Promise<number> {
    return (await defaultSqlDriver()).epochMillis();
  }
}

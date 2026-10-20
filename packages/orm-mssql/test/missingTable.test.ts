/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { OrmDriver } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';

/** The INFORMATION_SCHEMA.COLUMNS rows of the tables the fake database holds. */
const COLUMNS = new Map<string, Array<Record<string, unknown>>>([['present_t', [{ COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null }]]]);

/** The real driver with the server taken out: it answers the two reflection queries from COLUMNS. */
class MissingTableMsSqlDriver extends MsSqlOrmDriver {
  public async executeOnDb(stmt: string, params: any[]): Promise<any> {
    return stmt.includes('FROM INFORMATION_SCHEMA.COLUMNS') ? (COLUMNS.get(params[0] as string) ?? []) : [];
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }
}

describe('mssql tableInfo of a missing table', () => {
  let driver: MissingTableMsSqlDriver;

  before(async () => {
    driver = await DI.child().resolve(MissingTableMsSqlDriver, [{ Name: 'mssql-missing', Driver: 'orm-driver-mssql', Database: 'test' }]);
  });

  it('answers null for a table that does not exist', async () => {
    expect(await driver.tableInfo('no_such_table')).to.equal(null);
  });

  it('answers the columns of a table that exists', async () => {
    expect((await driver.tableInfo('present_t')).map((c) => c.Name)).to.deep.equal(['Id']);
  });
});

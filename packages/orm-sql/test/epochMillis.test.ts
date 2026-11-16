import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, QueryContext, SqlExpressions } from '@spinajs/orm';

import type { SqlDriver } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

class FixedEpochExpressions extends SqlExpressions {
  public epochMillis(): string {
    return 'EPOCH_MS()';
  }
}

interface ICall {
  stmt: string;
  params: unknown[];
  context: QueryContext;
  inTransaction: boolean;
}

describe('SqlDriver.epochMillis', () => {
  let driver: FakeSqliteDriver;
  let calls: ICall[];

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    driver = (await DI.resolve(Orm)).Connections.get('sqlite') as FakeSqliteDriver;
    driver.Container.register(FixedEpochExpressions).as(SqlExpressions);

    calls = [];
    (driver as SqlDriver).executeOnDb = async (stmt: string | object, params: unknown[], context: QueryContext) => {
      calls.push({ stmt: stmt as string, params, context, inTransaction: driver.CurrentTransaction !== undefined });
      // Postgres returns a BIGINT as text.
      return [{ ms: '1767225600123' }];
    };
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('selects the dialect epoch expression in one read statement and returns a number', async () => {
    expect(await driver.epochMillis()).to.equal(1767225600123);
    expect(calls).to.deep.equal([{ stmt: 'SELECT EPOCH_MS() AS ms', params: [], context: QueryContext.Select, inTransaction: false }]);
  });

  it('runs inside the transaction in scope', async () => {
    await driver.transaction(async () => driver.epochMillis());
    expect(calls.map((c) => c.inTransaction)).to.deep.equal([true]);
  });
});

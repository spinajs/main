import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

const list = (count: number, step = 1) => Array.from({ length: count }, (_, i) => i * step);

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => r.Id).sort((a, b) => a - b);
}

describe('sqlite whereIn with long lists', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_in', (table) => {
        table.int('Id').primaryKey();
        table.dateTime('At');
      });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds a list longer than 1000 as one JSON parameter', () => {
    const result = compiled(driver().select().from('gap_in').whereIn('Id', list(1001)));

    expect(result.expression).to.contain('`Id` IN (SELECT value FROM json_each(?))');
    expect(result.bindings).to.deep.eq([JSON.stringify(list(1001))]);
  });

  it('keeps a list of 1000 expanded', () => {
    const result = compiled(driver().select().from('gap_in').whereIn('Id', list(1000)));

    expect(result.expression).to.contain('`Id` IN (?,?,');
    expect(result.bindings).to.have.length(1000);
  });

  it('returns the rows of 50 000 keys', async () => {
    await driver().insert().into('gap_in').values(list(50000).map((Id) => ({ Id })));

    const found = await ids(driver().select().select('Id').from('gap_in').whereIn('Id', list(50000, 2)).asRaw());

    expect(found).to.have.length(25000);
    expect(found.every((id) => id % 2 === 0)).to.eq(true);
  });

  it('excludes the rows of 50 000 keys with whereNotIn', async () => {
    await driver().insert().into('gap_in').values(list(50000).map((Id) => ({ Id })));

    const found = await ids(driver().select().select('Id').from('gap_in').whereNotIn('Id', list(50000, 2)).asRaw());

    expect(found).to.have.length(25000);
    expect(found.every((id) => id % 2 === 1)).to.eq(true);
  });

  it('matches Date values like where() does, in both list forms', async () => {
    const at = [new Date(2026, 0, 2, 3, 4, 5, 6), new Date(2026, 0, 3, 3, 4, 5, 6), new Date(2026, 0, 4, 3, 4, 5, 6)];
    await driver()
      .insert()
      .into('gap_in')
      .values(at.map((At, i) => ({ Id: i + 1, At })));
    const filler = Array.from({ length: 1500 }, (_, i) => new Date(2020, 0, 1, 0, 0, 0, i));

    expect(await ids(driver().select().from('gap_in').whereIn('At', [at[0], at[2]]).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(driver().select().from('gap_in').whereIn('At', [at[0], ...filler, at[2]]).asRaw())).to.deep.eq([1, 3]);
  });
});

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ICompilerOutput, ISelectQueryBuilder, Orm, Wrapper } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('sqlite Wrapper.Text', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('tw_item', (table) => {
        table.int('Id').primaryKey();
      });
    await driver().insert().into('tw_item').values([{ Id: 1 }, { Id: 2 }, { Id: 3 }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compares an integer column cast to text with text values', async () => {
    expect(await ids(driver().select().from('tw_item').where(Wrapper.Text('Id'), '=', '2').asRaw())).to.deep.eq([2]);
    expect(await ids(driver().select().from('tw_item').whereIn(Wrapper.Text('Id'), ['1', '3', 'x']).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(driver().select().from('tw_item').whereNotIn(Wrapper.Text('Id'), ['1']).asRaw())).to.deep.eq([2, 3]);
    expect(await ids(driver().select().from('tw_item').whereIn(Wrapper.Text('Id'), []).asRaw())).to.deep.eq([]);
  });

  it('casts the column of the query alias', () => {
    expect(compiled(driver().select().from('tw_item', 'i').whereIn(Wrapper.Text('Id'), ['1'])).expression).to.contain('CAST(`i`.`Id` AS TEXT) IN (?)');
  });

  it('binds a long list of text values as one parameter', async () => {
    const values = [...Array.from({ length: 1500 }, (_, i) => `x${i}`), '2'];
    expect(compiled(driver().select().from('tw_item').whereIn(Wrapper.Text('Id'), values)).bindings).to.have.length(1);
    expect(await ids(driver().select().from('tw_item').whereIn(Wrapper.Text('Id'), values).asRaw())).to.deep.eq([2]);
  });

  it('refuses a wrapped column with a sub-query', () => {
    expect(() => driver().select().from('tw_item').whereIn(Wrapper.Text('Id'), driver().select().from('tw_item') as unknown as ISelectQueryBuilder)).to.throw(InvalidArgument, /a wrapped column takes a list of values/);
  });
});

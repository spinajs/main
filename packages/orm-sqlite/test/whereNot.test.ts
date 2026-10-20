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

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('sqlite whereNot(group)', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('wn_item', (table) => {
        table.int('Id').primaryKey();
        table.string('Flag', 8);
      });
    await driver()
      .insert()
      .into('wn_item')
      .values([
        { Id: 1, Flag: 'a' },
        { Id: 2, Flag: 'b' },
        { Id: 3, Flag: null },
      ]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('negates a group; a NULL inside it leaves the row out', async () => {
    expect(
      await ids(
        driver()
          .select()
          .from('wn_item')
          .whereNot(function () {
            this.where('Flag', 'a');
          })
          .asRaw(),
      ),
    ).to.deep.eq([2]);
    expect(
      await ids(
        driver()
          .select()
          .from('wn_item')
          .whereNot(function () {
            this.where('Flag', 'a').orWhere('Flag', 'b');
          })
          .asRaw(),
      ),
    ).to.deep.eq([]);
  });

  it('compiles to NOT ( ... ), an empty group to 1 = 0', () => {
    const negated = driver()
      .select()
      .from('wn_item')
      .where('Id', '>', 0)
      .whereNot(function () {
        this.where('Flag', 'a').orWhere('Id', 2);
      });
    expect(compiled(negated).expression).to.contain('WHERE `Id` > ? AND NOT ( `Flag` = ? OR `Id` = ? )');
    expect(compiled(driver().select().from('wn_item').whereNot(function () {})).expression).to.contain('WHERE 1 = 0');
  });

  it('keeps the negation in a clone; whereNot(column, value) still compares with !=', () => {
    const query = driver()
      .select()
      .from('wn_item')
      .whereNot(function () {
        this.where('Flag', 'a');
      });
    expect(compiled(query.clone()).expression).to.contain('NOT ( `Flag` = ? )');
    expect(compiled(driver().select().from('wn_item').whereNot('Flag', 'a')).expression).to.contain('`Flag` != ?');
  });
});

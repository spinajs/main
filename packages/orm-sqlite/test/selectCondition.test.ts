import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, ISelectQueryBuilder, Orm, Wrapper, outer } from '@spinajs/orm';
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

/** `[Id, row[alias]]` per row, by Id. */
async function values(query: PromiseLike<unknown>, alias: string): Promise<[number, unknown][]> {
  return ((await query) as Record<string, unknown>[]).map((r): [number, unknown] => [Number(r.Id), r[alias]]).sort((a, b) => a[0] - b[0]);
}

describe('sqlite selectCondition()', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('sc_item', (table) => {
        table.int('Id').primaryKey();
        table.string('Flag', 8);
      });
    await driver()
      .schema()
      .createTable('sc_child', (table) => {
        table.string('ParentRef', 64);
      });
    await driver()
      .insert()
      .into('sc_item')
      .values([
        { Id: 1, Flag: 'a' },
        { Id: 2, Flag: 'b' },
        { Id: 3, Flag: null },
      ]);
    await driver().insert().into('sc_child').values([{ ParentRef: '1' }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const isA = () =>
    driver()
      .select()
      .select('Id')
      .from('sc_item')
      .selectCondition('isA', function () {
        this.where('Flag', 'a');
      });

  it('selects a condition as a boolean column', async () => {
    expect(await values(isA(), 'isA')).to.deep.eq([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(compiled(isA()).expression).to.contain('CASE WHEN `Flag` = ? THEN 1 ELSE 0 END AS `isA`');
  });

  it('selects a correlated sub-query; an empty condition is true', async () => {
    const hasChild = driver()
      .select()
      .select('Id')
      .from('sc_item')
      .selectCondition('hasChild', function () {
        // The interface type: a test file that augments ISelectQueryBuilder (orm-http's filter()) leaves the class behind.
        this.whereExist(driver().select().from('sc_child', 'c').whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'))) as unknown as ISelectQueryBuilder);
      });
    expect(await values(hasChild, 'hasChild')).to.deep.eq([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(await values(driver().select().select('Id').from('sc_item').selectCondition('all', function () {}), 'all')).to.deep.eq([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  it('asRaw() keeps the driver value; a clone keeps the column and its conversion', async () => {
    const query = isA();
    expect((await values(query.clone().asRaw(), 'isA')).map(([, v]) => Number(v))).to.deep.eq([1, 0, 0]);
    expect(await values(query.clone(), 'isA')).to.deep.eq([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});

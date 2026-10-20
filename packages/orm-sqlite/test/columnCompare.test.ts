import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
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

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

/** Children whose ParentRef is the text of the enclosing parent's integer Id. */
// Typed as the interface: a test file that augments ISelectQueryBuilder (orm-http's filter()) leaves the class behind.
const sub = (q: unknown) => q as ISelectQueryBuilder;
const children = () => sub(driver().select().from('cc_child', 'c').whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'))));

describe('sqlite whereColumn and outer()', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('cc_parent', (table) => {
        table.int('Id').primaryKey();
        table.string('Kind', 16);
      });
    for (const name of ['cc_child', 'cc_mark']) {
      await driver()
        .schema()
        .createTable(name, (table) => {
          table.string('ParentRef', 64);
          table.string('Kind', 16);
        });
    }
    await driver()
      .insert()
      .into('cc_parent')
      .values([
        { Id: 1, Kind: 'a' },
        { Id: 2, Kind: 'b' },
        { Id: 3, Kind: 'a' },
        { Id: 4, Kind: 'a' },
      ]);
    await driver()
      .insert()
      .into('cc_child')
      .values([
        { ParentRef: '1', Kind: 'x' },
        { ParentRef: '3', Kind: 'y' },
      ]);
    await driver()
      .insert()
      .into('cc_mark')
      .values([
        { ParentRef: '3', Kind: 'y' },
        { ParentRef: '1', Kind: 'a' },
      ]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('correlates a sub-query with the query whereExist() is called on', async () => {
    expect(await ids(driver().select().from('cc_parent').whereExist(children()).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(driver().select().from('cc_parent', 'p').whereNotExists(children()).asRaw())).to.deep.eq([2, 4]);
  });

  it('qualifies each side by its query alias, or by the table without one', () => {
    expect(compiled(driver().select().from('cc_parent').whereExist(children())).expression).to.contain('`c`.`ParentRef` = CAST(`cc_parent`.`Id` AS TEXT)');
    expect(compiled(driver().select().from('cc_parent', 'p').whereExist(children())).expression).to.contain('`c`.`ParentRef` = CAST(`p`.`Id` AS TEXT)');
    expect(compiled(driver().select().from('cc_child', 'c').whereColumn('Kind', '<>', 'ParentRef')).expression).to.contain('`c`.`Kind` <> `c`.`ParentRef`');
  });

  it('reaches the query two levels up', async () => {
    const marks = sub(driver().select().from('cc_mark', 'm').whereColumn('Kind', '=', outer('Kind')).whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'), 2)));
    const query = driver().select().from('cc_parent', 'p').whereExist(children().whereExist(marks));
    expect(compiled(query).expression).to.contain('`m`.`Kind` = `c`.`Kind` AND `m`.`ParentRef` = CAST(`p`.`Id` AS TEXT)');
    expect(await ids(query.asRaw())).to.deep.eq([3]);
  });

  it('correlates inside a nested group and through whereIn()', async () => {
    const grouped = driver()
      .select()
      .from('cc_parent', 'p')
      .where(function () {
        this.where('Kind', 'b').orWhere(function () {
          this.whereExist(children());
        });
      });
    expect(await ids(grouped.asRaw())).to.deep.eq([1, 2, 3]);
    const kinds = sub(driver().select().select('Kind').from('cc_mark', 'm').whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'))));
    expect(await ids(driver().select().from('cc_parent').whereIn('Kind', kinds).asRaw())).to.deep.eq([1]);
  });

  it('a clone correlates with the clone', async () => {
    const query = driver().select().from('cc_parent', 'p').whereExist(children());
    const copy = query.clone().setAlias('q');
    expect(compiled(copy).expression).to.contain('CAST(`q`.`Id` AS TEXT)');
    expect(compiled(query).expression).to.contain('CAST(`p`.`Id` AS TEXT)');
    expect(await ids(copy.asRaw())).to.deep.eq([1, 3]);
  });

  it('refuses outer() outside a sub-query and a level below one', () => {
    expect(() => driver().select().from('cc_parent').whereColumn('Id', '=', outer('Id')).toDB()).to.throw(InvalidOperation, /outer\(\): the query is not a sub-query 1 level\(s\) deep/);
    expect(() => outer('Id', 0)).to.throw(InvalidArgument, /levels must be a positive integer/);
  });

  it('refuses a sub-query that is already correlated with another query', () => {
    const first = driver().select().from('cc_parent', 'p');
    const shared = children();
    first.whereExist(shared);
    const kinds = sub(driver().select().select('ParentRef').from('cc_mark', 'm').whereColumn('Kind', '=', outer('Kind')));
    driver().select().from('cc_parent', 'p').whereIn('Id', kinds);
    for (const attach of [
      () => driver().select().from('cc_parent', 'q').whereExist(shared),
      () => driver().select().from('cc_parent', 'q').whereNotExists(shared),
      () => driver().select().from('cc_parent', 'q').whereIn('Id', kinds),
      () => driver().select().from('cc_parent', 'q').whereNotIn('Id', kinds),
    ]) {
      expect(attach).to.throw(InvalidArgument, /already correlated with another query; attach a clone\(\) of it/);
    }
    expect(compiled(first).expression).to.contain('CAST(`p`.`Id` AS TEXT)');
  });

  it('a sub-query correlated with a query attaches anywhere in that query', async () => {
    const query = driver().select().from('cc_parent', 'p');
    const inner = children().correlateWith(query as never);
    query.where(function () {
      this.where('Kind', 'b').orWhere(function () {
        this.whereExist(inner);
      });
    });
    expect(await ids(query.asRaw())).to.deep.eq([1, 2, 3]);
  });

  it('whereNotIn() names itself when a wrapped column gets a sub-query', () => {
    expect(() => driver().select().from('cc_parent').whereNotIn(Wrapper.Text('Id'), children())).to.throw(InvalidArgument, /^whereNotIn\(\): a wrapped column takes a list of values/);
  });
});

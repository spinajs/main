import 'mocha';
import { expect } from 'chai';
import { ISelectQueryBuilder, Wrapper, outer } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('postgres whereColumn and outer() (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;
  // Typed as the interface: a test file that augments ISelectQueryBuilder (orm-http's filter()) leaves the class behind.
  const sub = (q: unknown) => q as ISelectQueryBuilder;
  const children = () => sub(pgdb!.driver.select().from('pg_cc_child', 'c').whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'))));

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('column_compare');
    const d = pgdb.driver;
    await d.schema().createTable('pg_cc_parent', (table) => {
      table.int('Id').primaryKey();
      table.string('Kind', 16);
    });
    for (const name of ['pg_cc_child', 'pg_cc_mark']) {
      await d.schema().createTable(name, (table) => {
        table.string('ParentRef', 64);
        table.string('Kind', 16);
      });
    }
    await d
      .insert()
      .into('pg_cc_parent')
      .values([
        { Id: 1, Kind: 'a' },
        { Id: 2, Kind: 'b' },
        { Id: 3, Kind: 'a' },
        { Id: 4, Kind: 'a' },
      ]);
    await d
      .insert()
      .into('pg_cc_child')
      .values([
        { ParentRef: '1', Kind: 'x' },
        { ParentRef: '3', Kind: 'y' },
      ]);
    await d
      .insert()
      .into('pg_cc_mark')
      .values([
        { ParentRef: '3', Kind: 'y' },
        { ParentRef: '1', Kind: 'a' },
      ]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('correlates through the text cast of an integer id', async () => {
    const d = pgdb!.driver;
    expect(await ids(d.select().from('pg_cc_parent').whereExist(children()).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(d.select().from('pg_cc_parent', 'p').whereNotExists(children()).asRaw())).to.deep.eq([2, 4]);
  });

  it('reaches the query two levels up, also from a clone', async () => {
    const d = pgdb!.driver;
    const marks = sub(d.select().from('pg_cc_mark', 'm').whereColumn('Kind', '=', outer('Kind')).whereColumn('ParentRef', '=', outer(Wrapper.Text('Id'), 2)));
    const query = d.select().from('pg_cc_parent', 'p').whereExist(children().whereExist(marks));
    expect(await ids(query.clone().setAlias('q').asRaw())).to.deep.eq([3]);
    expect(await ids(query.asRaw())).to.deep.eq([3]);
  });
});

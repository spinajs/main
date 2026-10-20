import 'mocha';
import { expect } from 'chai';
import { Wrapper } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('postgres Wrapper.Text (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('text_wrap');
    await pgdb.driver.schema().createTable('pg_tw_item', (table) => {
      table.int('Id').primaryKey();
    });
    await pgdb.driver.insert().into('pg_tw_item').values([{ Id: 1 }, { Id: 2 }, { Id: 3 }]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('compares an integer column with text values, which postgres refuses without the cast', async () => {
    const d = pgdb!.driver;
    expect(await ids(d.select().from('pg_tw_item').where(Wrapper.Text('Id'), '=', '2').asRaw())).to.deep.eq([2]);
    expect(await ids(d.select().from('pg_tw_item').whereIn(Wrapper.Text('Id'), ['1', '3', 'x']).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(d.select().from('pg_tw_item').whereNotIn(Wrapper.Text('Id'), ['1']).asRaw())).to.deep.eq([2, 3]);
  });

  it('binds a long list of text values as one array parameter', async () => {
    const values = [...Array.from({ length: 1500 }, (_, i) => `x${i}`), '2'];
    expect(await ids(pgdb!.driver.select().from('pg_tw_item').whereIn(Wrapper.Text('Id'), values).asRaw())).to.deep.eq([2]);
  });
});

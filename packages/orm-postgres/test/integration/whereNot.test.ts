import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('postgres whereNot(group) (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('where_not');
    await pgdb.driver.schema().createTable('pg_wn_item', (table) => {
      table.int('Id').primaryKey();
      table.string('Flag', 8);
    });
    await pgdb.driver
      .insert()
      .into('pg_wn_item')
      .values([
        { Id: 1, Flag: 'a' },
        { Id: 2, Flag: 'b' },
        { Id: 3, Flag: null },
      ]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('negates a group; a NULL inside it leaves the row out', async () => {
    const d = pgdb!.driver;
    expect(
      await ids(
        d
          .select()
          .from('pg_wn_item')
          .whereNot(function () {
            this.where('Flag', 'a');
          })
          .asRaw(),
      ),
    ).to.deep.eq([2]);
    expect(
      await ids(
        d
          .select()
          .from('pg_wn_item')
          .whereNot(function () {})
          .asRaw(),
      ),
    ).to.deep.eq([]);
  });
});

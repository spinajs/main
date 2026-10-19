import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const list = (count: number, step = 1) => Array.from({ length: count }, (_, i) => i * step);

async function ids(query: PromiseLike<unknown>): Promise<number[]> {
  return ((await query) as { Id: number }[]).map((r) => Number(r.Id)).sort((a, b) => a - b);
}

describe('postgres whereIn with long lists (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('where_in');
    await pgdb.driver.schema().createTable('pg_gap_in', (table) => {
      table.int('Id').primaryKey();
      table.dateTime('At');
    });
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_gap_in');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('returns the rows of 70 000 keys, more than one statement may bind', async () => {
    await pgdb!.driver.insert().into('pg_gap_in').values(list(50000).map((Id) => ({ Id })));

    const found = await ids(pgdb!.driver.select().select('Id').from('pg_gap_in').whereIn('Id', list(70000, 2)).asRaw());

    expect(found).to.have.length(25000);
    expect(found.every((id) => id % 2 === 0)).to.eq(true);
  });

  it('matches Date values like where() does, in both list forms', async () => {
    const at = [new Date(2026, 0, 2, 3, 4, 5, 6), new Date(2026, 0, 3, 3, 4, 5, 6), new Date(2026, 0, 4, 3, 4, 5, 6)];
    await pgdb!.driver
      .insert()
      .into('pg_gap_in')
      .values(at.map((At, i) => ({ Id: i + 1, At })));
    const filler = Array.from({ length: 1500 }, (_, i) => new Date(2020, 0, 1, 0, 0, 0, i));

    expect(await ids(pgdb!.driver.select().from('pg_gap_in').whereIn('At', [at[0], at[2]]).asRaw())).to.deep.eq([1, 3]);
    expect(await ids(pgdb!.driver.select().from('pg_gap_in').whereIn('At', [at[0], ...filler, at[2]]).asRaw())).to.deep.eq([1, 3]);
  });
});

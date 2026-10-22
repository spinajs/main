import 'mocha';
import { expect } from 'chai';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

@Connection('pg')
@Model('pg_gap_counter')
class PgGapCounter extends ModelBase {
  @Primary()
  public Id: number;

  public Hits: number;

  public Name: string;
}

describe('postgres update increment (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('increment');
    await pgdb.driver.schema().createTable('pg_gap_counter', (table) => {
      table.int('Id').primaryKey();
      table.int('Hits').notNull();
      table.string('Name');
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_gap_counter');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('lands every one of 10 concurrent increments', async () => {
    await pgdb!.driver.insert().into('pg_gap_counter').values({ Id: 1, Hits: 0, Name: 'a' });

    await Promise.all(Array.from({ length: 10 }, () => pgdb!.driver.update().in('pg_gap_counter').increment('Hits').where('Id', 1)));

    const row = (await pgdb!.driver.select().from('pg_gap_counter').where('Id', 1).first()) as { Hits: number };
    expect(row.Hits).to.eq(10);
  });

  it('increments through Model.update next to set values and reports the rows it touched', async () => {
    await pgdb!.driver.insert().into('pg_gap_counter').values({ Id: 1, Hits: 5, Name: 'a' });

    const hit = await PgGapCounter.update({ Name: 'b' }).increment('Hits', 2).where('Id', 1);
    const miss = await PgGapCounter.update({}).increment('Hits').where('Id', 2);

    expect(hit.RowsAffected).to.eq(1);
    expect(miss.RowsAffected).to.eq(0);

    const row = await PgGapCounter.where('Id', 1).first();
    expect(row.Hits).to.eq(7);
    expect(row.Name).to.eq('b');
  });
});

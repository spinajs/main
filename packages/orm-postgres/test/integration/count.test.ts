import 'mocha';
import { expect } from 'chai';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

@Connection('pg')
@Model('pg_gap_count')
class PgGapCount extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

describe('postgres counts (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('count');
    await pgdb.driver.schema().createTable('pg_gap_count', (table) => {
      table.int('Id').primaryKey();
      table.string('Name');
    });
    await pgdb.orm.reloadTableInfo();
    await pgdb.driver
      .insert()
      .into('pg_gap_count')
      .values([
        { Id: 1, Name: 'a' },
        { Id: 2, Name: 'b' },
        { Id: 3, Name: 'b' },
      ]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('Model.count resolves a number', async () => {
    const count = await PgGapCount.count();

    expect(typeof count).to.eq('number');
    expect(count).to.eq(3);
  });

  it('Model.count with a filter resolves a number', async () => {
    expect(await PgGapCount.count((q) => q.where('Name', 'b'))).to.equal(2);
  });

  it('selectCount resolves a number', async () => {
    const count = await pgdb!.driver.select().from('pg_gap_count').selectCount();

    expect(typeof count).to.eq('number');
    expect(count).to.eq(3);
  });
});

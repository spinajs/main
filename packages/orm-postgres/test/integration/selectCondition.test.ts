import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

describe('postgres selectCondition() (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('select_condition');
    await pgdb.driver.schema().createTable('pg_sc_item', (table) => {
      table.int('Id').primaryKey();
      table.string('Flag', 8);
    });
    await pgdb.driver
      .insert()
      .into('pg_sc_item')
      .values([
        { Id: 1, Flag: 'a' },
        { Id: 2, Flag: null },
      ]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('reads the column as a boolean', async () => {
    const rows = (await pgdb!.driver
      .select()
      .select('Id')
      .from('pg_sc_item')
      .selectCondition('isA', function () {
        this.where('Flag', 'a');
      })) as Record<string, unknown>[];
    expect(rows.map((r): [number, unknown] => [Number(r.Id), r.isA]).sort((a, b) => a[0] - b[0])).to.deep.eq([
      [1, true],
      [2, false],
    ]);
  });
});

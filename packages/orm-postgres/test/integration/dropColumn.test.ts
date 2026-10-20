import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

describe('postgres dropColumn (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('drop_column');
    await pgdb.driver.schema().createTable('pg_dc_t', (table) => {
      table.int('Id').primaryKey();
      table.string('Role', 64);
    });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('drops a mixed-case column', async () => {
    await pgdb!.driver.schema().alterTable('pg_dc_t', (table) => table.dropColumn('Role'));

    expect((await pgdb!.driver.tableInfo('pg_dc_t')).map((c) => c.Name)).to.deep.eq(['Id']);
  });
});

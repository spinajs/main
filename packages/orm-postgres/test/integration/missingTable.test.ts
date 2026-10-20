import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

describe('postgres tableInfo of a missing table (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('missing_table');
    await pgdb.driver.schema().createTable('present_t', (table) => {
      table.int('Id').primaryKey();
      table.string('Name');
    });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('answers null for a table that does not exist', async () => {
    expect(await pgdb!.driver.tableInfo('no_such_table')).to.equal(null);
  });

  it('answers the columns of a table that exists', async () => {
    expect((await pgdb!.driver.tableInfo('present_t')).map((c) => c.Name)).to.deep.equal(['Id', 'Name']);
  });
});

import 'mocha';
import { expect } from 'chai';
import { QueryContext } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

describe('postgres case-sensitive columns (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('case_sensitive');
    await pgdb.driver.schema().createTable('pg_case_key', (table) => {
      table.string('fs', 64).notNull().primaryKey().caseSensitive();
      table.string('path', 512).notNull().primaryKey().caseSensitive();
    });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('declares the C collation on the key columns', async () => {
    const rows = await pgdb!.driver.executeOnDb(`SELECT column_name, collation_name FROM information_schema.columns WHERE table_name = 'pg_case_key' ORDER BY column_name`, [], QueryContext.Select);

    expect(rows).to.deep.equal([
      { column_name: 'fs', collation_name: 'C' },
      { column_name: 'path', collation_name: 'C' },
    ]);
  });

  it('keeps case variants of a key apart', async () => {
    await pgdb!.driver
      .insert()
      .into('pg_case_key')
      .values([
        { fs: 'u', path: 'Report.pdf' },
        { fs: 'u', path: 'report.pdf' },
      ]);

    expect(await pgdb!.driver.select().from('pg_case_key').where({ path: 'report.pdf' }).asRaw()).to.deep.equal([{ fs: 'u', path: 'report.pdf' }]);
  });
});

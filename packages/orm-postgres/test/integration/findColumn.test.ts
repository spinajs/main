import 'mocha';
import { expect } from 'chai';
import { findColumn } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

describe('postgres findColumn (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('find_column');
    await pgdb.driver.schema().createTable('pg_fc_users', (table) => {
      table.int('Id').primaryKey();
      table.string('Role', 64);
    });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('finds a mixed-case column by a lower-case name, spelled so that it works quoted', async () => {
    const role = findColumn(await pgdb!.driver.tableInfo('pg_fc_users'), 'role');

    expect(role?.Name).to.eq('Role');
    await pgdb!.driver.insert().into('pg_fc_users').values({ Id: 1, [role!.Name]: 'admin' });
    expect(await pgdb!.driver.select().columns([role!.Name]).from('pg_fc_users')).to.deep.eq([{ Role: 'admin' }]);
  });
});

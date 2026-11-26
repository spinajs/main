import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueryContext } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('postgres savepoints started together inside one transaction (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;
  const insert = (Name: string) => pgdb!.driver.insert().into('ps_row').values({ Name });
  const names = async (): Promise<string[]> => (await pgdb!.driver.select<Array<{ Name: string }>>().from('ps_row').orderBy('Name')).map((r) => r.Name);

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('parallel_savepoints');
    await pgdb.driver.schema().createTable('ps_row', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name');
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('ps_row');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('commits each savepoint with its own rows only', async () => {
    const outcomes = await pgdb!.driver.transaction(async () => {
      await insert('caller');
      return Promise.allSettled([
        pgdb!.driver.transaction(async () => {
          await insert('a1');
          await tick();
          await insert('a2');
        }),
        pgdb!.driver.transaction(async () => {
          await insert('b1');
          throw new Error('b fails');
        }),
      ]);
    });

    expect(outcomes.map((o) => o.status)).to.deep.equal(['fulfilled', 'rejected']);
    expect(await names()).to.deep.equal(['a1', 'a2', 'caller']);
  });

  it('recovers a failed statement of one savepoint while another runs beside it', async () => {
    const outcomes = await pgdb!.driver.transaction(async () => {
      await insert('caller');
      return Promise.allSettled([
        pgdb!.driver.transaction(async () => {
          await insert('a1');
          await tick();
          await insert('a2');
        }),
        pgdb!.driver.transaction(async () => {
          await pgdb!.driver.executeOnDb('SELECT * FROM "no_such_table"', [], QueryContext.Select);
        }),
      ]);
    });

    expect(outcomes.map((o) => o.status)).to.deep.equal(['fulfilled', 'rejected']);
    expect(await names()).to.deep.equal(['a1', 'a2', 'caller']);
  });
});

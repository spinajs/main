import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, DateTime as DateTimeColumn, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('pg')
@Model('pg_gap_doc')
class PgGapDoc extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Data: unknown;

  @DateTimeColumn()
  public At: DateTime;
}

describe('postgres Model.update with column converters (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('model_update');
    await pgdb.driver.schema().createTable('pg_gap_doc', (table) => {
      table.int('Id').primaryKey();
      table.text('Data');
      table.dateTime('At');
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_gap_doc');
    await PgGapDoc.insert({ Id: 1, Data: { a: 1 }, At: DateTime.local(2026, 1, 2, 3, 4, 5, 6) });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('writes a @Json and a @DateTime column through their converters', async () => {
    const later = DateTime.local(2026, 2, 3, 4, 5, 6, 7);

    const result = await PgGapDoc.update({ Data: { b: [1, 2] }, At: later }).where('Id', 1);

    expect(result.RowsAffected).to.eq(1);
    const doc = (await PgGapDoc.where('Id', 1).first()) as PgGapDoc;
    expect(doc.Data).to.deep.eq({ b: [1, 2] });
    expect(doc.At.toMillis()).to.eq(later.toMillis());
  });

  it('refuses an update without a where clause', async () => {
    await expect(PgGapDoc.update({ Data: {} })).to.be.rejectedWith(InvalidArgument, 'has no where clause');
  });
});

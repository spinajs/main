import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Connection, Model, ModelBase, Primary, UniqueViolation } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('pg')
@Model('pg_gap_split')
class PgGapSplit extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string;
}

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ Id: i + 1, Name: `n${i}` }));

describe('postgres insert split by bound-parameter limit (integration)', function () {
  this.timeout(120000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('insert_split');
    await pgdb.driver.schema().createTable('pg_gap_split', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name');
      table.string('Code');
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_gap_split');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('inserts 40 000 rows of two columns through several statements', async () => {
    const result = await pgdb!.driver.insert().into('pg_gap_split').values(rows(40000));

    expect(result.RowsAffected).to.eq(40000);
    expect(Number(await pgdb!.driver.select().from('pg_gap_split').selectCount())).to.eq(40000);
  });

  it('rolls every statement back when the last one fails', async () => {
    const payload = rows(40000);
    payload[39999].Id = 1;

    await expect(pgdb!.driver.insert().into('pg_gap_split').values(payload)).to.be.rejectedWith(UniqueViolation);
    expect(Number(await pgdb!.driver.select().from('pg_gap_split').selectCount())).to.eq(0);
  });

  it('backfills the keys of 40 000 models inserted through several statements', async () => {
    const models = Array.from({ length: 40000 }, (_, i) => new PgGapSplit({ Name: `n${i}`, Code: `c${i}` }));

    await PgGapSplit.insert(models);

    expect(new Set(models.map((m) => Number(m.Id))).size).to.eq(40000);
  });
});

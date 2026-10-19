import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Connection, Int64, Model, ModelBase, OrmException, Primary } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('pg')
@Model('pg_gap_int64')
class PgGapInt64 extends ModelBase {
  @Primary()
  public Id: number;

  @Int64('string')
  public Counter: string;

  @Int64('bigint')
  public Big: bigint;

  @Int64('number')
  public Small: number;
}

describe('postgres @Int64 columns (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('int64');
    await pgdb.driver.schema().createTable('pg_gap_int64', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.bigint('Counter');
      table.bigint('Big');
      table.bigint('Small');
    });
    await pgdb.orm.reloadTableInfo();
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('hydrates each column as its declared JS type, as on sqlite', async () => {
    const model = new PgGapInt64({ Counter: '42', Big: 42n, Small: 42 });
    await PgGapInt64.insert(model);

    const read = (await PgGapInt64.where('Id', model.Id).first()) as PgGapInt64;

    expect(read.Counter).to.eq('42');
    expect(read.Big).to.eq(42n);
    expect(read.Small).to.eq(42);
  });

  it('writes bigint and string values through Model.update', async () => {
    const model = new PgGapInt64({ Counter: '1', Big: 1n, Small: 1 });
    await PgGapInt64.insert(model);

    await PgGapInt64.update({ Counter: '44', Big: 43n }).where('Id', model.Id);

    const read = (await PgGapInt64.where('Id', model.Id).first()) as PgGapInt64;
    expect(read.Counter).to.eq('44');
    expect(read.Big).to.eq(43n);
  });

  it('converts where and whereIn bindings on an @Int64 column', async () => {
    const one = new PgGapInt64({ Counter: '7001', Big: 7001n, Small: 1 });
    const two = new PgGapInt64({ Counter: '7044', Big: 7043n, Small: 2 });
    await PgGapInt64.insert(one);
    await PgGapInt64.insert(two);

    expect(((await PgGapInt64.where('Big', 7043n).first()) as PgGapInt64).Id).to.eq(two.Id);
    expect(((await PgGapInt64.where('Counter', '7044').first()) as PgGapInt64).Id).to.eq(two.Id);
    expect(((await PgGapInt64.where('Counter', ' 7044 ').first()) as PgGapInt64).Id).to.eq(two.Id);

    const found = (await PgGapInt64.query().whereIn('Counter', ['7001', '7044'])) as PgGapInt64[];
    expect(found.map((m) => m.Id).sort()).to.deep.eq([one.Id, two.Id].sort());

    const long = [...Array.from({ length: 1500 }, (_, i) => String(1000000 + i)), '7044'];
    const foundLong = (await PgGapInt64.query().whereIn('Counter', long)) as PgGapInt64[];
    expect(foundLong.map((m) => m.Id)).to.deep.eq([two.Id]);
  });

  it('keeps a value beyond 2^53 exact as string and bigint', async () => {
    await pgdb!.driver.insert().into('pg_gap_int64').values({ Id: 99, Counter: '9007199254740993', Big: '9007199254740993' });

    const read = (await PgGapInt64.where('Id', 99).first()) as PgGapInt64;
    expect(read.Counter).to.eq('9007199254740993');
    expect(read.Big).to.eq(9007199254740993n);
  });

  it("refuses a value beyond 2^53 on an @Int64('number') column", async () => {
    await pgdb!.driver.insert().into('pg_gap_int64').values({ Id: 100, Small: '9007199254740993' });

    await expect(PgGapInt64.where('Id', 100).first()).to.be.rejectedWith(OrmException, 'MAX_SAFE_INTEGER');
  });
});

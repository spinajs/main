import 'mocha';
import * as chai from 'chai';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary, QueryContext, RawQuery } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);

@Connection('pg')
@Model('pg_raw_date_doc')
class PgRawDateDoc extends ModelBase<PgRawDateDoc> {
  @Primary()
  public id: number;

  @DateTimeColumn()
  public at: DateTime;
}

describe('postgres raw statements bind dates the way columns store them (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  const ids = async (sql: string, bindings: unknown[]): Promise<number[]> => ((await pgdb!.driver.executeOnDb(sql, bindings, QueryContext.Select)) as { id: number }[]).map((r) => r.id);

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('raw_dates');
    await pgdb.driver.schema().createTable('pg_raw_date_doc', (table) => {
      table.int('id').primaryKey();
      table.dateTime('at');
    });
    await pgdb.orm.reloadTableInfo();
    await PgRawDateDoc.insert({ id: 1, at: DateTime.fromMillis(AT) });
    await PgRawDateDoc.insert({ id: 2, at: DateTime.fromMillis(AT + 3_600_000) });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('compares a bound Date with model-written values', async () => {
    expect(await ids('SELECT id FROM pg_raw_date_doc WHERE at > ? ORDER BY id', [new Date(AT)])).to.deep.eq([2]);
    expect(await ids('SELECT id FROM pg_raw_date_doc WHERE at >= ? ORDER BY id', [new Date(AT)])).to.deep.eq([1, 2]);
  });

  it('compares a bound DateTime with model-written values', async () => {
    expect(await ids('SELECT id FROM pg_raw_date_doc WHERE at = ?', [DateTime.fromMillis(AT)])).to.deep.eq([1]);
  });

  it('converts the bindings of a RawQuery in a where clause', async () => {
    const rows = (await pgdb!.driver.select().from('pg_raw_date_doc').where(RawQuery.create('at < ?', [new Date(AT + 1)]))) as { id: number }[];
    expect(rows.map((r) => r.id)).to.deep.eq([1]);
  });
});

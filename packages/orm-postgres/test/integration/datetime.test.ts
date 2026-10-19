import 'mocha';
import * as chai from 'chai';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary, QueryContext } from '@spinajs/orm';
import { DateTime, Settings } from 'luxon';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);

@Connection('pg')
@Model('pg_dt_doc')
class PgDtDoc extends ModelBase<PgDtDoc> {
  @Primary()
  public id: number;

  @DateTimeColumn()
  public at: DateTime;
}

async function inZone<T>(zone: string, fn: () => PromiseLike<T>): Promise<T> {
  const tz = process.env.TZ;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const luxonZone = Settings.defaultZone;
  process.env.TZ = zone;
  Settings.defaultZone = zone;
  try {
    return await fn();
  } finally {
    // Deleting TZ alone keeps Node in the last zone; setting it back first resets it.
    process.env.TZ = tz ?? system;
    if (tz === undefined) delete process.env.TZ;
    Settings.defaultZone = luxonZone;
  }
}

describe('postgres datetimes (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;
  const query = async <T>(sql: string, bindings: unknown[] = []): Promise<T[]> => (await pgdb!.driver.executeOnDb(sql, bindings, QueryContext.Select)) as T[];

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('datetimes');
    await pgdb.driver.schema().createTable('pg_dt_doc', (table) => {
      table.int('id').primaryKey();
      table.dateTime('at');
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_dt_doc');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('runs the session in UTC', async () => {
    expect(await query('SHOW TimeZone')).to.deep.eq([{ TimeZone: 'UTC' }]);
  });

  it('stores the instant, whatever the zone of the writer', async () => {
    await inZone('Asia/Kolkata', () => PgDtDoc.insert({ id: 1, at: DateTime.fromMillis(AT) }));

    const [row] = await query<{ ms: string }>('SELECT EXTRACT(EPOCH FROM at) * 1000 AS ms FROM pg_dt_doc WHERE id = 1');
    expect(Number(row.ms)).to.eq(AT);
  });

  it('reads in one zone the instant another zone wrote, and filters by it', async () => {
    await inZone('Asia/Kolkata', () => PgDtDoc.insert({ id: 1, at: DateTime.fromMillis(AT) }));

    await inZone('America/New_York', async () => {
      const doc = (await PgDtDoc.where('id', 1).first()) as PgDtDoc;
      expect(doc.at.toMillis()).to.eq(AT);
      expect(doc.at.zoneName).to.eq('UTC');
      expect(await PgDtDoc.where('at', '>', new Date(AT - 1))).to.have.length(1);
      expect(await PgDtDoc.where('at', '>', DateTime.fromMillis(AT).setZone('Asia/Kolkata'))).to.have.length(0);
    });
  });

  it('keeps both instants of a DST fold apart', async () => {
    const first = Date.UTC(2026, 9, 25, 0, 30);
    const second = Date.UTC(2026, 9, 25, 1, 30);
    await inZone('Europe/Warsaw', async () => {
      await PgDtDoc.insert({ id: 1, at: DateTime.fromMillis(first) });
      await PgDtDoc.insert({ id: 2, at: DateTime.fromMillis(second) });
    });

    const docs = (await PgDtDoc.all().orderBy('at')) as PgDtDoc[];
    expect(docs.map((d) => d.at.toMillis())).to.deep.eq([first, second]);
  });

  it('reads a column without time zone as UTC', async () => {
    await pgdb!.driver.executeOnDb('CREATE TABLE IF NOT EXISTS pg_naive (at TIMESTAMP)', [], QueryContext.Schema);
    await pgdb!.driver.executeOnDb("INSERT INTO pg_naive VALUES ('2026-10-19 12:00:00.123')", [], QueryContext.Insert);

    const [row] = await inZone('Asia/Kolkata', () => query<{ at: Date }>('SELECT at FROM pg_naive'));
    expect(row.at.getTime()).to.eq(AT);
  });
});

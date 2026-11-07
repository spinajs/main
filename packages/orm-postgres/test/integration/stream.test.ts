import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Connection, HasMany, Model, ModelBase, Primary, QueryContext, Relation } from '@spinajs/orm';
import sinon from 'sinon';
import { useProcessTimeZone } from './harness.js';
import { adminQuery, bootPostgres, PgTestDb, requirePostgres } from './support.js';
import { PGLITE } from './pglite-mode.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('pg')
@Model('pg_stream_note')
class PgStreamNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public item_id: number;
}

@Connection('pg')
@Model('pg_stream_item')
class PgStreamItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(PgStreamNote, { foreignKey: 'item_id', primaryKey: 'Id' })
  public Notes: Relation<PgStreamNote, PgStreamItem>;
}

async function collect<T>(source: AsyncIterable<T>, stopAfter = Number.POSITIVE_INFINITY): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= stopAfter) {
      break;
    }
  }
  return out;
}

describe('postgres stream (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('stream');
    await pgdb.driver.executeOnDb('CREATE TABLE pg_stream_item ("Id" int PRIMARY KEY, "Name" text NOT NULL, "At" timestamp NOT NULL)', [], QueryContext.Schema);
    await pgdb.driver.executeOnDb(`INSERT INTO pg_stream_item ("Id", "Name", "At") SELECT g, 'n' || g, timestamp '2026-01-01 00:00:00' + g * interval '1 minute' FROM generate_series(1, 1000) g`, [], QueryContext.Insert);
    await pgdb.driver.executeOnDb('CREATE TABLE pg_stream_note ("Id" serial PRIMARY KEY, "Body" text NOT NULL, "item_id" int NOT NULL)', [], QueryContext.Schema);
    await pgdb.driver.executeOnDb(`INSERT INTO pg_stream_note ("Body", "item_id") VALUES ('first', 1), ('last', 1000)`, [], QueryContext.Insert);
    await pgdb.orm.reloadTableInfo();
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await pgdb?.dispose();
  });

  it('streams every row in batches, parsed like a plain select (UTC timestamps)', async () => {
    const restore = useProcessTimeZone('Europe/Warsaw');
    try {
      const streamed = await collect(pgdb!.driver.select().from('pg_stream_item').order('Id').stream({ batchSize: 100 }));
      const plain = await pgdb!.driver.select().from('pg_stream_item').order('Id');

      expect(streamed).to.have.length(1000);
      expect(streamed).to.deep.equal(plain);
    } finally {
      restore();
    }
  });

  it('hydrates models', async () => {
    const cursor = sinon.spy(pgdb!.driver, 'executeStreamOnDb');
    const rows = await collect(PgStreamItem.select().order('Id').stream({ batchSize: 64 }));

    expect(rows).to.have.length(1000);
    expect(rows[999]).to.be.instanceOf(PgStreamItem);
    expect(rows[999].Name).to.eq('n1000');
    expect(cursor.callCount).to.eq(PGLITE ? 0 : 1);
  });

  it('gives the client back to the pool when the loop breaks', async () => {
    const cursor = sinon.spy(pgdb!.driver, 'executeStreamOnDb');
    await collect(PgStreamItem.select().order('Id').stream({ batchSize: 100 }), 150);

    expect(cursor.callCount).to.eq(PGLITE ? 0 : 1);
    expect(pgdb!.driver.poolMetrics().InUse).to.eq(0);
  });

  it('gives the client back to the pool when the loop body throws', async () => {
    const loop = async () => {
      for await (const item of PgStreamItem.select().order('Id').stream({ batchSize: 100 })) {
        if (item.Id === 150) {
          throw new Error('consumer failed');
        }
      }
    };

    await expect(loop()).to.be.rejectedWith('consumer failed');
    expect(pgdb!.driver.poolMetrics().InUse).to.eq(0);
  });

  it('pages by keyset inside a transaction, populates every batch and runs statements in the loop body', async () => {
    const driver = pgdb!.driver;
    const cursor = sinon.spy(driver, 'executeStreamOnDb');

    const items = await driver.transaction(async () => {
      await driver.executeOnDb(`INSERT INTO pg_stream_item ("Id", "Name", "At") VALUES (1001, 'tx', timestamp '2026-01-01 00:00:00')`, [], QueryContext.Insert);
      const seen: PgStreamItem[] = [];
      for await (const item of PgStreamItem.select().order('Id').populate('Notes').stream({ batchSize: 100 })) {
        // a second statement on the transaction's connection, from inside the loop body: a cursor would never answer it
        await driver.update().in('pg_stream_item').update({ Name: `seen-${item.Id}` }).where({ Id: item.Id });
        seen.push(item);
      }
      return seen;
    });

    expect(items).to.have.length(1001);
    expect(cursor.callCount).to.eq(0);
    expect(items[0].Notes.map((n) => n.Body)).to.deep.equal(['first']);
    expect(items[999].Notes.map((n) => n.Body)).to.deep.equal(['last']);
    expect(items[500].Notes.Populated).to.eq(true);
    const renamed = (await driver.executeOnDb(`SELECT count(*)::int AS n FROM pg_stream_item WHERE "Name" LIKE 'seen-%'`, [], QueryContext.Select)) as Array<{ n: number }>;
    expect(renamed[0].n).to.eq(1001);
    await driver.executeOnDb('DELETE FROM pg_stream_item WHERE "Id" = 1001', [], QueryContext.Delete);
    await driver.executeOnDb(`UPDATE pg_stream_item SET "Name" = 'n' || "Id"`, [], QueryContext.Update);
  });

  const openStream = async () => {
    const rows = pgdb!.driver.select().from('pg_stream_item').order('Id').stream({ batchSize: 100 })[Symbol.asyncIterator]();
    await rows.next();
    await adminQuery(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${pgdb!.name}'`);
    return rows;
  };

  it('rejects and drops the client when the backend dies mid-stream', async function () {
    this.timeout(10000);
    const rows = await openStream();

    await expect(collect({ [Symbol.asyncIterator]: () => rows })).to.be.rejected;
    expect(pgdb!.driver.poolMetrics().InUse).to.eq(0);
  });

  it('settles a loop that leaves after the backend died between batches', async function () {
    this.timeout(10000);
    const rows = await openStream();
    await new Promise((resolve) => setTimeout(resolve, 300));

    await rows.return?.(undefined);
    expect(pgdb!.driver.poolMetrics().InUse).to.eq(0);
  });
});

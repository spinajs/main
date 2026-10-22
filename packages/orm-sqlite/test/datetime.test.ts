import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, CreatedAt, DateTime as DateTimeColumn, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import { DateTime, Settings } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);

@Connection('sqlite')
@Model('dt_doc')
class DtDoc extends ModelBase<DtDoc> {
  @Primary()
  public id: number;

  @DateTimeColumn()
  public at: DateTime;

  @CreatedAt()
  public created: DateTime;
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

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite datetimes', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('dt_doc', (table) => {
        table.int('id').primaryKey();
        table.dateTime('at');
        table.dateTime('created');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('stores fixed-width ISO-8601 UTC text', async () => {
    await inZone('Asia/Kolkata', () => DtDoc.insert({ id: 1, at: DateTime.fromMillis(AT) }));

    const [row] = (await driver().executeOnDb('SELECT at FROM dt_doc WHERE id = 1', [], QueryContext.Select)) as { at: string }[];
    expect(row.at).to.eq('2026-10-19T12:00:00.123Z');
  });

  it('reads in one zone the instant another zone wrote', async () => {
    await inZone('Asia/Kolkata', () => DtDoc.insert({ id: 1, at: DateTime.fromMillis(AT) }));

    const doc = await inZone('America/New_York', async () => (await DtDoc.where('id', 1).first()));
    expect(doc.at.toMillis()).to.eq(AT);
    expect(doc.at.zoneName).to.eq('UTC');
  });

  it('serializes datetimes as ISO 8601 in UTC', async () => {
    const doc = new DtDoc({ id: 1, at: DateTime.fromMillis(AT).setZone('Asia/Kolkata') });
    expect((doc.toJSON() as { at: unknown }).at).to.eq('2026-10-19T12:00:00.123Z');
  });

  it('filters in one zone by instants bound in another, in where() and in raw SQL', async () => {
    await inZone('Asia/Kolkata', () => DtDoc.insert({ id: 1, at: DateTime.fromMillis(AT) }));

    await inZone('America/New_York', async () => {
      expect(await DtDoc.where('at', '>', new Date(AT - 1))).to.have.length(1);
      expect(await DtDoc.where('at', '>', DateTime.fromMillis(AT).setZone('Asia/Kolkata'))).to.have.length(0);
      const rows = (await driver().executeOnDb('SELECT id FROM dt_doc WHERE at = ?', [DateTime.fromMillis(AT).setZone('Asia/Kolkata')], QueryContext.Select)) as { id: number }[];
      expect(rows.map((r) => r.id)).to.deep.eq([1]);
    });
  });

  it('keeps both instants of a DST fold apart and in order', async () => {
    const first = Date.UTC(2026, 9, 25, 0, 30);
    const second = Date.UTC(2026, 9, 25, 1, 30);

    await inZone('Europe/Warsaw', async () => {
      await DtDoc.insert({ id: 2, at: DateTime.fromMillis(second) });
      await DtDoc.insert({ id: 1, at: DateTime.fromMillis(first) });
    });

    const docs = await DtDoc.all().orderBy('at');
    expect(docs.map((d) => [d.id, d.at.toMillis()])).to.deep.eq([
      [1, first],
      [2, second],
    ]);
  });

  it('stamps CreatedAt as a UTC DateTime', async () => {
    const doc = new DtDoc({ id: 1, at: DateTime.fromMillis(AT) });
    await inZone('Asia/Kolkata', () => doc.insert());

    expect(doc.created.zoneName).to.eq('UTC');
    expect(doc.created.toMillis()).to.be.within(Date.now() - 60_000, Date.now());
  });

  it('compares stored instants with the database clock, and stamps with it', async () => {
    await DtDoc.insert({ id: 1, at: DateTime.fromMillis(Date.now() - 3_600_000) });
    await DtDoc.insert({ id: 2, at: DateTime.fromMillis(Date.now() + 3_600_000) });
    expect(driver().now().Query).to.eq("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

    await inZone('Asia/Kolkata', async () => {
      const past = (await DtDoc.where('at', '<=', driver().now())) as DtDoc[];
      expect(past.map((d) => d.id)).to.deep.eq([1]);

      const before = Date.now();
      await driver().executeOnDb(`INSERT INTO dt_doc (id, at) VALUES (3, ${driver().now().Query})`, [], QueryContext.Insert);
      const stamped = await DtDoc.where('id', 3).first();
      expect(stamped.at.toMillis()).to.be.within(before - 1000, Date.now() + 1000);
    });
  });
});

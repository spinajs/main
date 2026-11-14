import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, CreatedAt, DateTime as DateTimeColumn, ICompilerOutput, Model, ModelBase, Orm, Primary, QueryContext, SqlOperator } from '@spinajs/orm';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { InvalidArgument } from '@spinajs/exceptions';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const AT = 1794612404654;

@Connection('sqlite')
@Model('dt_seconds')
class SecondsDoc extends ModelBase<SecondsDoc> {
  @Primary()
  public Id: number;

  @DateTimeColumn()
  public At: DateTime;
}

@Connection('sqlite')
@Model('dt_millis')
class MillisDoc extends ModelBase<MillisDoc> {
  @Primary()
  public Id: number;

  @DateTimeColumn({ unit: 'milliseconds' })
  public At: DateTime;

  @DateTimeColumn({ unit: 'milliseconds', nullable: true })
  public Until: DateTime | null;
}

@Connection('sqlite')
@Model('dt_created')
class CreatedDoc extends ModelBase<CreatedDoc> {
  @Primary()
  public Id: number;

  @CreatedAt()
  public Created: DateTime;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function storedTypes(table: string): Promise<string[]> {
  const rows = (await driver().executeOnDb(`SELECT typeof(At) AS t FROM ${table} ORDER BY Id`, [], QueryContext.Select)) as { t: string }[];
  return rows.map((r) => r.t);
}

describe('sqlite @DateTime on an INTEGER column', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver().executeOnDb('CREATE TABLE dt_seconds (Id INTEGER PRIMARY KEY, At INTEGER NOT NULL)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE dt_created (Id INTEGER PRIMARY KEY, Created INTEGER)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE dt_millis (Id INTEGER PRIMARY KEY, At INTEGER NOT NULL, Until INTEGER NULL)', [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('writes unix seconds into a column declared INTEGER in upper case', async () => {
    await SecondsDoc.insert({ Id: 1, At: DateTime.fromMillis(AT) });
    const doc = new SecondsDoc({ Id: 2, At: DateTime.fromMillis(AT + 5000) });
    await doc.insert();

    expect(await storedTypes('dt_seconds')).to.deep.eq(['integer', 'integer']);
    const rows = (await driver().executeOnDb('SELECT At FROM dt_seconds ORDER BY Id', [], QueryContext.Select)) as { At: number }[];
    expect(rows.map((r) => r.At)).to.deep.eq([Math.floor(AT / 1000), Math.floor(AT / 1000) + 5]);
    expect((await SecondsDoc.where('Id', 1).first()).At.toMillis()).to.eq(Math.floor(AT / 1000) * 1000);
  });

  it('stamps @CreatedAt as unix seconds into a column declared INTEGER', async () => {
    const before = Math.floor(Date.now() / 1000);
    await new CreatedDoc({ Id: 1 }).insert();

    const rows = (await driver().executeOnDb('SELECT Created, typeof(Created) AS t FROM dt_created', [], QueryContext.Select)) as { Created: number; t: string }[];
    expect(rows[0].t).to.eq('integer');
    expect(rows[0].Created).to.be.within(before, Math.floor(Date.now() / 1000));
  });

  describe('with unit milliseconds', () => {
    // inserted out of time order, so the id order is not the time order
    beforeEach(async () => {
      await MillisDoc.insert({ Id: 1, At: DateTime.fromMillis(AT + 2000) });
      await MillisDoc.insert({ Id: 2, At: DateTime.fromMillis(AT) });
      await new MillisDoc({ Id: 3, At: DateTime.fromMillis(AT + 1000) }).insert();
    });

    it('stores integer milliseconds in every row', async () => {
      expect(await storedTypes('dt_millis')).to.deep.eq(['integer', 'integer', 'integer']);
      const rows = (await driver().executeOnDb('SELECT At FROM dt_millis ORDER BY Id', [], QueryContext.Select)) as { At: number }[];
      expect(rows.map((r) => r.At)).to.deep.eq([AT + 2000, AT, AT + 1000]);
    });

    it('stores and binds an instant with a fraction of a millisecond as whole milliseconds', async () => {
      await MillisDoc.insert({ Id: 4, At: DateTime.fromMillis(AT + 0.7) });

      expect(await storedTypes('dt_millis')).to.deep.eq(['integer', 'integer', 'integer', 'integer']);
      const docs = await MillisDoc.where('At', DateTime.fromMillis(AT + 0.7)).orderBy('Id');
      expect(docs.map((d) => d.Id)).to.deep.eq([2, 4]);
    });

    it('reads the instant back to the millisecond', async () => {
      const doc = await MillisDoc.where('Id', 2).first();
      expect(doc.At.toMillis()).to.eq(AT);
      expect(doc.At.zoneName).to.eq('UTC');
    });

    it('filters a range by a DateTime and by a number of milliseconds', async () => {
      const byDateTime = await MillisDoc.where('At', '>=', DateTime.fromMillis(AT + 1000)).orderBy('Id');
      expect(byDateTime.map((d) => d.Id)).to.deep.eq([1, 3]);

      const byNumber = await MillisDoc.where('At', '>=', AT + 1000).orderBy('Id');
      expect(byNumber.map((d) => d.Id)).to.deep.eq([1, 3]);
    });

    it('filters BETWEEN by DateTime bounds and by bounds in milliseconds', async () => {
      for (const bounds of [[DateTime.fromMillis(AT + 500), DateTime.fromMillis(AT + 2000)], [AT + 500, AT + 2000]]) {
        const query = () => MillisDoc.query().where('At', SqlOperator.BETWEEN, bounds).orderBy('Id');
        expect((query().toDB() as ICompilerOutput).bindings).to.deep.eq([AT + 500, AT + 2000]);
        expect((await query()).map((d) => d.Id)).to.deep.eq([1, 3]);
      }
    });

    it('filters whereIn by DateTimes and numbers', async () => {
      const docs = await MillisDoc.query().whereIn('At', [DateTime.fromMillis(AT), AT + 2000]).orderBy('Id');
      expect(docs.map((d) => d.Id)).to.deep.eq([1, 2]);
    });

    it('orders by time', async () => {
      const docs = await MillisDoc.all().orderBy('At');
      expect(docs.map((d) => d.Id)).to.deep.eq([2, 3, 1]);
    });

    it('still serializes as ISO 8601', async () => {
      const doc = await MillisDoc.where('Id', 2).first();
      expect((doc.toJSON() as { At: unknown }).At).to.eq(DateTime.fromMillis(AT, { zone: 'utc' }).toISO());
    });

    it('accepts a property typed DateTime | null when declared nullable', async () => {
      await new MillisDoc({ Id: 4, At: DateTime.fromMillis(AT), Until: DateTime.fromMillis(AT + 60_000) }).insert();

      const rows = (await driver().executeOnDb('SELECT Id, Until FROM dt_millis ORDER BY Id', [], QueryContext.Select)) as { Id: number; Until: number | null }[];
      expect(rows.map((r) => r.Until)).to.deep.eq([null, null, null, AT + 60_000]);
      expect((await MillisDoc.where('Id', 1).first()).Until).to.eq(null);
      expect((await MillisDoc.where('Id', 4).first()).Until!.toMillis()).to.eq(AT + 60_000);
    });
  });

  it('refuses a property typed DateTime | null without nullable', () => {
    expect(() => {
      class Unmarked extends ModelBase<Unmarked> {
        @DateTimeColumn()
        public At: DateTime | null;
      }
      return Unmarked;
    }).to.throw('must be DateTime type');
  });

  it('refuses a unit other than seconds or milliseconds', () => {
    // Reflect.apply stands in for an untyped JavaScript caller
    const decorate = (): PropertyDecorator => Reflect.apply(DateTimeColumn, undefined, [{ unit: 'minutes' }]) as PropertyDecorator;
    expect(() => decorate()(MillisDoc.prototype, 'At')).to.throw(InvalidArgument, "unit must be 'seconds' or 'milliseconds'");
  });
});

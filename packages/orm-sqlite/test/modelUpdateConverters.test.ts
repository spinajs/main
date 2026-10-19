import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, DateTime as DateTimeColumn, Json, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('gap_doc')
class GapDoc extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Data: unknown;

  @DateTimeColumn()
  public At: DateTime;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite Model.update with column converters', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_doc', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.text('Data');
        table.dateTime('At');
      });
    await db().reloadTableInfo();
    await GapDoc.insert({ Data: { a: 1 }, At: DateTime.local(2026, 1, 2, 3, 4, 5, 6) });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('writes a @Json and a @DateTime column through their converters', async () => {
    const later = DateTime.local(2026, 2, 3, 4, 5, 6, 7);

    const result = await GapDoc.update({ Data: { b: [1, 2] }, At: later }).where('Id', 1);

    expect(result.RowsAffected).to.eq(1);
    const doc = (await GapDoc.where('Id', 1).first()) as GapDoc;
    expect(doc.Data).to.deep.eq({ b: [1, 2] });
    expect(doc.At.toMillis()).to.eq(later.toMillis());
  });

  it('binds null as SQL NULL, not as JSON text', async () => {
    await GapDoc.update({ Data: null }).where('Id', 1);

    const row = (await driver().select().from('gap_doc').where('Id', 1).first()) as { Data: unknown };
    expect(row.Data).to.eq(null);
  });

  it('accepts an ISO string for a @DateTime column', async () => {
    await GapDoc.update({ At: '2026-02-03T04:05:06.007' as unknown as DateTime }).where('Id', 1);

    const doc = (await GapDoc.where('Id', 1).first()) as GapDoc;
    expect(doc.At.toMillis()).to.eq(DateTime.local(2026, 2, 3, 4, 5, 6, 7).toMillis());
  });

  it('rejects a string that is not a date instead of writing NULL', async () => {
    expect(() => GapDoc.update({ At: 'not a date' as unknown as DateTime })).to.throw(InvalidArgument, 'At');

    const row = (await driver().select().from('gap_doc').where('Id', 1).first()) as { At: unknown };
    expect(row.At).to.not.eq(null);
  });

  it('refuses an update without a where clause', async () => {
    await expect(GapDoc.update({ Data: {} })).to.be.rejectedWith(InvalidArgument, 'has no where clause');
  });
});

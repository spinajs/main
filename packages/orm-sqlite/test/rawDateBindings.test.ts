import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Orm, Primary, QueryContext, RawQuery } from '@spinajs/orm';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);

@Connection('sqlite')
@Model('raw_date_doc')
class RawDateDoc extends ModelBase<RawDateDoc> {
  @Primary()
  public id: number;

  @DateTimeColumn()
  public at: DateTime;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function ids(sql: string, bindings: unknown[]): Promise<number[]> {
  const rows = (await driver().executeOnDb(sql, bindings, QueryContext.Select)) as { id: number }[];
  return rows.map((r) => r.id);
}

describe('sqlite raw statements bind dates the way columns store them', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('raw_date_doc', (table) => {
        table.int('id').primaryKey();
        table.dateTime('at');
      });
    await db().reloadTableInfo();
    await RawDateDoc.insert({ id: 1, at: DateTime.fromMillis(AT) });
    await RawDateDoc.insert({ id: 2, at: DateTime.fromMillis(AT + 3_600_000) });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compares a bound Date with model-written values', async () => {
    expect(await ids('SELECT id FROM raw_date_doc WHERE at > ? ORDER BY id', [new Date(AT)])).to.deep.eq([2]);
    expect(await ids('SELECT id FROM raw_date_doc WHERE at >= ? ORDER BY id', [new Date(AT)])).to.deep.eq([1, 2]);
  });

  it('compares a bound DateTime with model-written values', async () => {
    expect(await ids('SELECT id FROM raw_date_doc WHERE at = ?', [DateTime.fromMillis(AT)])).to.deep.eq([1]);
  });

  it('converts the bindings of a RawQuery in a where clause', async () => {
    const rows = (await driver().select().from('raw_date_doc').where(RawQuery.create('at < ?', [new Date(AT + 1)]))) as { id: number }[];
    expect(rows.map((r) => r.id)).to.deep.eq([1]);
  });
});

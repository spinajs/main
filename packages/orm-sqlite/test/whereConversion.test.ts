import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, ICompilerOutput, Model, ModelBase, Orm, Primary, QueryContext, SqlOperator } from '@spinajs/orm';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const AT = Date.UTC(2026, 10, 13, 23, 26, 44, 654);
const SECONDS = Math.floor(AT / 1000);
const iso = (millis: number) => DateTime.fromMillis(millis, { zone: 'utc' }).toISO()!;

@Connection('sqlite')
@Model('where_conversion')
class WhereConversion extends ModelBase {
  @Primary()
  public Id: number;

  public AtInt: number;

  public AtText: string;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

function bindings(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): unknown[] {
  return (query.toDB() as ICompilerOutput).bindings ?? [];
}

async function ids(query: PromiseLike<WhereConversion[]>): Promise<number[]> {
  return (await query).map((r) => r.Id).sort();
}

describe('sqlite where(), whereIn() and BETWEEN bind a DateTime alike on a column without a converter', function () {
  this.timeout(10000);

  const from = DateTime.fromMillis(AT);
  const to = DateTime.fromMillis(AT + 10_000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver().executeOnDb('CREATE TABLE where_conversion (Id INTEGER PRIMARY KEY, AtInt INTEGER, AtText TEXT)', [], QueryContext.Schema);
    for (const [id, offset] of [
      [1, -10_000],
      [2, 0],
      [3, 10_000],
    ]) {
      await driver().executeOnDb('INSERT INTO where_conversion (Id, AtInt, AtText) VALUES (?, ?, ?)', [id, SECONDS + offset / 1000, iso(AT + offset)], QueryContext.Insert);
    }
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds Unix seconds against an INTEGER column', async () => {
    expect(bindings(WhereConversion.query().where('AtInt', '>=', from))).to.deep.eq([SECONDS]);
    expect(bindings(WhereConversion.query().whereIn('AtInt', [from]))).to.deep.eq([SECONDS]);
    expect(bindings(WhereConversion.query().where('AtInt', SqlOperator.BETWEEN, [from, to]))).to.deep.eq([SECONDS, SECONDS + 10]);

    expect(await ids(WhereConversion.query().where('AtInt', '>=', from))).to.deep.eq([2, 3]);
    expect(await ids(WhereConversion.query().whereIn('AtInt', [from]))).to.deep.eq([2]);
    expect(await ids(WhereConversion.query().whereNotIn('AtInt', [from]))).to.deep.eq([1, 3]);
    expect(await ids(WhereConversion.query().where('AtInt', SqlOperator.BETWEEN, [from, to]))).to.deep.eq([2, 3]);
  });

  it('binds ISO 8601 text against a TEXT column', async () => {
    expect(bindings(WhereConversion.query().where('AtText', '>=', from))).to.deep.eq([iso(AT)]);
    expect(bindings(WhereConversion.query().whereIn('AtText', [from]))).to.deep.eq([iso(AT)]);
    expect(bindings(WhereConversion.query().where('AtText', SqlOperator.BETWEEN, [from, to]))).to.deep.eq([iso(AT), iso(AT + 10_000)]);

    expect(await ids(WhereConversion.query().where('AtText', '>=', from))).to.deep.eq([2, 3]);
    expect(await ids(WhereConversion.query().whereIn('AtText', [from]))).to.deep.eq([2]);
    expect(await ids(WhereConversion.query().where('AtText', SqlOperator.BETWEEN, [from, to]))).to.deep.eq([2, 3]);
  });
});

import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Connection, IColumnDescriptor, ICompilerOutput, Model, ModelBase, Orm, Primary, SqlOperator } from '@spinajs/orm';
import { DateTime } from 'luxon';
import * as sinon from 'sinon';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

const AT = Date.UTC(2026, 10, 13, 23, 26, 44, 654);
const SECONDS = Math.floor(AT / 1000);
const SQL_TEXT = '2026-11-13 23:26:44.654';

@Connection('sqlite')
@Model('where_conversion')
class WhereConversion extends ModelBase {
  @Primary()
  public Id: number;

  public At: number;

  public Txt: string;
}

function col(Name: string, Type: string): IColumnDescriptor {
  return { Name, Type, NativeType: Type, MaxLength: 0, Comment: '', DefaultValue: null, Unsigned: false, Nullable: true, PrimaryKey: Name === 'Id', AutoIncrement: false, Converter: null, Schema: 'sqlite', Unique: false, Uuid: false, Ignore: false, IsForeignKey: false, ForeignKeyDescription: null, Aggregate: false, Virtual: false };
}

function bindings(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): unknown[] {
  return (query.toDB() as ICompilerOutput).bindings ?? [];
}

describe('a value bound against a column without a declared converter', () => {
  beforeEach(async () => {
    const tableInfo = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfo.resolves(null as unknown as IColumnDescriptor[]);
    tableInfo.withArgs('where_conversion').resolves([col('Id', 'int'), col('At', 'int'), col('Txt', 'text')]);

    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  for (const [label, value] of [
    ['DateTime', DateTime.fromMillis(AT)],
    ['Date', new Date(AT)],
  ] as const) {
    it(`binds a ${label} as Unix seconds in where(), whereIn() and BETWEEN on an int column`, () => {
      expect(bindings(WhereConversion.query().where('At', '>=', value))).to.deep.eq([SECONDS]);
      expect(bindings(WhereConversion.query().whereIn('At', [value]))).to.deep.eq([SECONDS]);
      expect(bindings(WhereConversion.query().whereNotIn('At', [value]))).to.deep.eq([SECONDS]);
      expect(bindings(WhereConversion.query().where('At', SqlOperator.BETWEEN, [value, value]))).to.deep.eq([SECONDS, SECONDS]);
    });

    it(`binds a ${label} as datetime text in where(), whereIn() and BETWEEN on a text column`, () => {
      expect(bindings(WhereConversion.query().where('Txt', '>=', value))).to.deep.eq([SQL_TEXT]);
      expect(bindings(WhereConversion.query().whereIn('Txt', [value]))).to.deep.eq([SQL_TEXT]);
      expect(bindings(WhereConversion.query().where('Txt', SqlOperator.BETWEEN, [value, value]))).to.deep.eq([SQL_TEXT, SQL_TEXT]);
    });
  }

  it('binds false as 0 and true as 1 in where() and whereIn()', () => {
    expect(bindings(WhereConversion.query().where('At', false))).to.deep.eq([0]);
    expect(bindings(WhereConversion.query().where('At', true))).to.deep.eq([1]);
    expect(bindings(WhereConversion.query().whereIn('At', [false, true]))).to.deep.eq([0, 1]);
  });

  it('leaves a value of a class without a converter alone', () => {
    expect(bindings(WhereConversion.query().where('At', '>=', 5))).to.deep.eq([5]);
    expect(bindings(WhereConversion.query().whereIn('Txt', ['a', 'b']))).to.deep.eq(['a', 'b']);
  });
});

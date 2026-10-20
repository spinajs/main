import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, IColumnDescriptor, InsertQueryBuilder, RawQuery, createQuery } from '@spinajs/orm';
import '@spinajs/log';
import * as sinon from 'sinon';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { CompositeKeyModel } from './Models/CompositeKeyModel.js';

function col(Name: string, over: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
  return {
    Type: 'VARCHAR',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: 'VARCHAR',
    Unsigned: false,
    Nullable: false,
    PrimaryKey: false,
    AutoIncrement: false,
    Name,
    Converter: null as any,
    Schema: 'sqlite',
    Unique: false,
    Uuid: false,
    Ignore: false,
    IsForeignKey: false,
    ForeignKeyDescription: null as any,
    Aggregate: false,
    Virtual: false,
    ...over,
  } as IColumnDescriptor;
}

/**
 * A driver may describe a column default as a RawQuery: an expression only the server can
 * evaluate (postgres reports `gen_random_uuid()` or `CURRENT_TIMESTAMP` in column_default).
 */
describe('server-side column defaults', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);

    const stub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    stub.returns(Promise.resolve(null as any));
    stub.withArgs('composite_table', undefined).returns(
      Promise.resolve([col('TenantId', { PrimaryKey: true, Type: 'INT' }), col('Code', { PrimaryKey: true, DefaultValue: RawQuery.create('gen_random_uuid()') }), col('Name', { Nullable: true, DefaultValue: 'unnamed' })]),
    );
    await DI.get(Orm)!.reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('leaves an expression default unset on a new model and copies a literal one', () => {
    const m = new CompositeKeyModel();

    expect(m.Code).to.equal(undefined);
    expect(m.Name).to.equal('unnamed');
  });

  it('inserts DEFAULT for an unset NOT NULL column the server fills', () => {
    const { query } = createQuery(CompositeKeyModel, InsertQueryBuilder);
    const out = query.values({ TenantId: 1, Code: undefined, Name: 'x' }).toDB();

    expect(out.expression).to.equal('INSERT INTO `composite_table` (`TenantId`,`Code`,`Name`) VALUES (?,DEFAULT,?)');
    expect(out.bindings).to.deep.equal([1, 'x']);
  });

  it('still refuses an explicit NULL for that column', () => {
    const { query } = createQuery(CompositeKeyModel, InsertQueryBuilder);

    expect(() => query.values({ TenantId: 1, Code: null, Name: 'x' }).toDB()).to.throw('value column Code cannot be null');
  });
});

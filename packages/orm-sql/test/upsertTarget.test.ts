/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Connection, IColumnDescriptor, InsertBehaviour, InsertQueryBuilder, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import '@spinajs/log';
import * as sinon from 'sinon';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('upsert_accounts')
class UpsertAccount extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Login: string;

  public Name: string;
}

function col(Name: string, over: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
  return {
    Type: 'VARCHAR',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: 'VARCHAR',
    Unsigned: false,
    Nullable: true,
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

/** The conflict target insert(InsertOrUpdate) hands to onDuplicate(). */
describe('model upsert conflict target', () => {
  let onDuplicate: sinon.SinonSpy;

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);

    const info = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    info.returns(Promise.resolve(null as any));
    // a primary key is reported Unique too, as the postgres driver does
    info.withArgs('upsert_accounts', undefined).returns(
      Promise.resolve([col('Id', { Type: 'INT', PrimaryKey: true, AutoIncrement: true, Unique: true, Nullable: false }), col('Email', { Unique: true }), col('Login', { Unique: true }), col('Name')]),
    );
    await DI.get(Orm)!.reloadTableInfo();

    sinon.stub(FakeSqliteDriver.prototype, 'executeOnDb').resolves({ RowsAffected: 1, LastInsertId: 1 });
    onDuplicate = sinon.spy(InsertQueryBuilder.prototype, 'onDuplicate');
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('targets the primary key when the row carries it', async () => {
    await new UpsertAccount({ Id: 7, Email: 'a@x.io', Name: 'A' }).insert(InsertBehaviour.InsertOrUpdate);

    expect(onDuplicate.firstCall.args[0]).to.deep.equal(['Id']);
  });

  it('targets the one unique column the row carries when the key is generated', async () => {
    await new UpsertAccount({ Email: 'a@x.io', Name: 'A' }).insert(InsertBehaviour.InsertOrUpdate);

    expect(onDuplicate.firstCall.args[0]).to.deep.equal(['Email']);
  });

  it('keeps the previous default when the row carries several unique columns', async () => {
    await new UpsertAccount({ Email: 'a@x.io', Login: 'a', Name: 'A' }).insert(InsertBehaviour.InsertOrUpdate);

    expect(onDuplicate.firstCall.args[0]).to.equal(undefined);
  });
});

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import * as sinon from 'sinon';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;

@Connection('sqlite')
@Model('upsert_code')
class UpsertCode extends ModelBase {
  @Primary({ generated: 'assigned' })
  public Code: string;

  public Email: string;

  public Name: string;
}

@Connection('sqlite')
@Model('upsert_login')
class UpsertLogin extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Login: string;

  public Name: string;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite static Model.insert(InsertOrUpdate) conflict target', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    // a TEXT key gets an autoindex, so sqlite reports it Unique next to Email
    await driver().executeOnDb('CREATE TABLE upsert_code (Code TEXT PRIMARY KEY, Email TEXT UNIQUE, Name TEXT)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE upsert_login (Id INTEGER PRIMARY KEY AUTOINCREMENT, Email TEXT UNIQUE, Login TEXT UNIQUE, Name TEXT)', [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('upserts on the primary key when the row carries it', async () => {
    const execute = sinon.spy(SqliteOrmDriver.prototype, 'executeOnDb');

    await UpsertCode.insert({ Code: 'k', Email: 'a@x.io', Name: 'A' }, InsertBehaviour.InsertOrUpdate);
    await UpsertCode.insert({ Code: 'k', Email: 'a@x.io', Name: 'B' }, InsertBehaviour.InsertOrUpdate);

    const sql = execute.getCalls().map((c) => String(c.args[0]));
    expect(sql.find((s) => s.includes('ON CONFLICT'))).to.include('ON CONFLICT(`Code`)');
    expect((await UpsertCode.all()).map((r) => [r.Code, r.Name])).to.deep.equal([['k', 'B']]);
  });

  it('upserts on the one unique column the row carries when the key is generated', async () => {
    await UpsertLogin.insert({ Email: 'a@x.io', Name: 'A' }, InsertBehaviour.InsertOrUpdate);
    await UpsertLogin.insert({ Email: 'a@x.io', Name: 'B' }, InsertBehaviour.InsertOrUpdate);

    expect((await UpsertLogin.all()).map((r) => [r.Email, r.Name])).to.deep.equal([['a@x.io', 'B']]);
  });
});

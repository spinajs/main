/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import * as _ from 'lodash';
import 'mocha';
import { Orm } from '../src/orm';
import { ConnectionConf, FakeSqliteDriver, FakeMysqlDriver, FakeTableQueryCompiler, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeDropTableCompiler } from './misc';
import * as sinon from 'sinon';
import { TableQueryCompiler, InsertQueryCompiler, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, DropTableCompiler } from '../src';

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('Orm general', () => {
  beforeEach(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(FakeDropTableCompiler).as(DropTableCompiler);
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  it('ORM should create connections', async () => {
    const connect1 = sinon.stub(FakeSqliteDriver.prototype, 'connect').returns(
      new Promise((resolve) => {
        resolve(
          new FakeSqliteDriver({
            Name: 'test',
            Driver: 'test',
            Options: {},
            PoolLimit: 0,
            DefaultConnection: false,
          }),
        );
      }),
    );
    const connect2 = sinon.stub(FakeMysqlDriver.prototype, 'connect').returns(
      new Promise((resolve) => {
        resolve(
          new FakeMysqlDriver({
            Name: 'test2',
            Driver: 'test',
            Options: {},
            PoolLimit: 0,
            DefaultConnection: false,
          }),
        );
      }),
    );

    // @ts-ignore
    const orm = await db();

    expect(connect1.calledOnce).to.be.true;
    expect(connect2.calledOnce).to.be.true;

    expect(orm.Connections).to.be.an('Map').that.have.length(2);
    expect(orm.Connections.get('main_connection')).to.be.not.null;
    expect(orm.Connections.get('sqlite')).to.be.not.null;
  });
});

/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { Orm, TableQueryCompiler, InsertQueryCompiler, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, DropTableCompiler, MigrationRunner } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver, FakeMysqlDriver, FakeTableQueryCompiler, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeDropTableCompiler } from './misc.js';
import "./../src/bootstrap.js";
import * as sinon from 'sinon';
import "@spinajs/log";

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

  beforeEach(async () =>{ 

    DI.removeAllListeners("di.resolve.Configuration");
    
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  })


  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  it('ORM should create connections', async () => {
    const connect1 = sinon.spy(FakeSqliteDriver.prototype, 'connect');
    const connect2 = sinon.spy(FakeMysqlDriver.prototype, 'connect');

    // @ts-ignore
    const orm = await db();

    expect(connect1.calledTwice).to.be.true;
    expect(connect2.calledOnce).to.be.true;

    expect(orm.Connections).to.be.an('Map').that.have.length(3);
    expect(orm.Connections.get('main_connection')).to.be.not.null;
    expect(orm.Connections.get('sqlite')).to.be.not.null;
    expect(orm.Connections.get('SampleConnection1')).to.be.not.null;
  });

  it('ORM should register value converters before the boot migration pass', async () => {
    // `Migration.up()` reaches `OrmMigrationService.ensureStorage()`, which probes the tracking
    // table with `driver.tableInfo()` - and a driver's `tableInfo()` may read the value-converter
    // map out of the container. While `registerDefaultConverters()` ran AFTER this call the map
    // was absent for the whole boot pass, so booting against an ALREADY migrated sqlite database
    // ( the only case that reaches the probe - a table that has to be created skips it ) died
    // with "Cannot read properties of undefined (reading 'get')" on every restart.
    let convertersAtUp: unknown = 'up() never ran';

    const up = sinon.stub(MigrationRunner.prototype, 'up').callsFake(async function (this: any) {
      // read off the same container the drivers resolve the map from, at the exact moment the
      // migration pass starts
      convertersAtUp = (this.orm as Orm).Container.get('__orm_db_value_converters__');
      return [];
    });

    await db();

    expect(up.calledOnce, 'boot did not run the migration pass at all').to.be.true;
    expect(convertersAtUp, 'converter map was absent when the boot migration pass started').to.be.instanceOf(Map);
    // an empty map would satisfy `instanceOf` while registering nothing
    expect((convertersAtUp as Map<string, unknown>).size, 'converter map was empty when the boot migration pass started').to.be.greaterThan(0);
  });
});

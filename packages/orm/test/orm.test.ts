/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { Orm, TableQueryCompiler, InsertQueryCompiler, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, DropTableCompiler, OrmMigrationGuard } from '../src/index.js';
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

  it('ORM maps an alias to its connection and skips one whose connection does not exist', async () => {
    class AliasConf extends ConnectionConf {
      public async resolve(): Promise<void> {
        await super.resolve();
        // ConnectionConf names no DefaultConnection, so 'default' is one of the missing targets.
        (this.Config as { db: Record<string, unknown> }).db.Aliases = { reporting: 'sqlite', authz: 'default', broken: 'nope' };
      }
    }
    DI.register(AliasConf).as(Configuration);

    const orm = await db();

    expect(orm.Connections.get('reporting')).to.equal(orm.Connections.get('sqlite'));
    expect(orm.Connections.has('authz')).to.be.false;
    expect(orm.Connections.has('broken')).to.be.false;
  });

  it('ORM should register value converters before the boot guard reads the tracking tables', async () => {
    // the guard reads each connection's tracking table through its migration service, and a
    // driver's `tableInfo()` may read the value-converter map out of the container. While
    // `registerDefaultConverters()` ran AFTER the boot's migration pass the map was absent there,
    // and booting against an ALREADY migrated sqlite database died with "Cannot read properties
    // of undefined (reading 'get')" on every restart.
    let convertersAtCheck: unknown = 'check() never ran';

    const check = sinon.stub(OrmMigrationGuard.prototype, 'check').callsFake(async function (orm: unknown) {
      convertersAtCheck = (orm as Orm).Container.get('__orm_db_value_converters__');
      return { pending: [], failed: [], warned: [] };
    });

    await DI.resolve(Orm);

    expect(check.calledOnce, 'boot did not run the guard at all').to.be.true;
    expect(convertersAtCheck, 'converter map was absent when the boot guard ran').to.be.instanceOf(Map);
    // an empty map would satisfy `instanceOf` while registering nothing
    expect((convertersAtCheck as Map<string, unknown>).size, 'converter map was empty when the boot guard ran').to.be.greaterThan(0);
  });
});

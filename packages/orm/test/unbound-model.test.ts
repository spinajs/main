import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import './../src/bootstrap.js';
import { Orm, OrmException, ModelBase, Model, Connection, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, DropTableCompiler } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver, FakeMysqlDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler, FakeDropTableCompiler } from './misc.js';

const expect = chai.expect;

describe('a model registered after the Orm resolved', () => {
  let late: typeof ModelBase | undefined;

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(FakeDropTableCompiler).as(DropTableCompiler);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
  });

  afterEach(() => {
    // the '__models__' bag is shared by every suite of the run
    if (late) {
      DI.unregister('__models__', late);
      late = undefined;
    }
    DI.clearCache();
  });

  it('throws an OrmException that names the model and says to import it before the Orm resolves', async () => {
    await DI.resolve(Orm);

    @Connection('sqlite')
    @Model('late_registered')
    class LateRegistered extends ModelBase {}
    late = LateRegistered;

    const calls: Array<[string, () => unknown]> = [
      ['where', () => LateRegistered.where('Id', 1)],
      ['all', () => LateRegistered.all()],
      ['query', () => LateRegistered.query()],
      ['select', () => LateRegistered.select()],
      ['get', () => LateRegistered.get(1)],
      ['getModelDescriptor', () => LateRegistered.getModelDescriptor()],
    ];

    for (const [name, call] of calls) {
      let thrown: unknown;
      try {
        call();
      } catch (err) {
        thrown = err;
      }

      expect(thrown, name).to.be.instanceOf(OrmException);
      expect((thrown as Error).message, name).to.contain('Model LateRegistered is not bound to the Orm');
      expect((thrown as Error).message, name).to.contain('Import the module that declares LateRegistered before the Orm resolves');
    }
  });

  it('throws the OrmException for a stub called without its class and for an anonymous class', () => {
    const anonymous = (() => class extends ModelBase {})();

    for (const call of [() => ModelBase.getModelDescriptor.call(undefined), () => anonymous.getModelDescriptor()]) {
      expect(call).to.throw(OrmException, 'Model <anonymous model> is not bound to the Orm');
    }
  });
});

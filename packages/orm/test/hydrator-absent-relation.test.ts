import './../src/bootstrap.js';
import '@spinajs/log';
import { DbPropertyHydrator, NonDbPropertyHydrator, OneToOneRelationHydrator, ModelHydrator } from './../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler, FakeConverter, FakeServerResponseMapper, FakeMysqlDriver } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, DatetimeValueConverter, ServerResponseMapper } from '../src/interfaces.js';
import * as chai from 'chai';
import 'mocha';

const expect = chai.expect;

// The relation hydrator itself: a row read from the database is not a Partial<Model1>.
function hydrated(row: object): Model4 | null | undefined {
  const m = new Model1();
  new OneToOneRelationHydrator().hydrate(m, row);
  return m.Owner.Value;
}

describe('Hydrator: when a belongsTo row counts as absent', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(OneToOneRelationHydrator).as(ModelHydrator);
    DI.register(FakeConverter).as(DatetimeValueConverter);
    DI.register(FakeServerResponseMapper).as(ServerResponseMapper);
  });

  beforeEach(async () => {
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('a row of nulls is absent', () => {
    expect(hydrated({ Owner: { Id: null, Data: null } })).to.equal(undefined);
  });

  it('a parsed JSON object is data, even when its own members are null', () => {
    const value = hydrated({ Owner: { Id: null, Data: { note: null } } });

    expect(value).to.be.instanceOf(Model4);
    expect(value).to.have.deep.property('Data', { note: null });
  });
});

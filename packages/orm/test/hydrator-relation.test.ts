/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import '@spinajs/log';
import { DbPropertyHydrator, NonDbPropertyHydrator, OneToOneRelationHydrator, ModelHydrator } from './../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { SingleRelation } from './../src/relation-objects.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler, FakeConverter, FakeServerResponseMapper, FakeMysqlDriver } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, DatetimeValueConverter, ServerResponseMapper } from '../src/interfaces.js';
import * as chai from 'chai';
import 'mocha';

const expect = chai.expect;

describe('Hydrator relation translation', () => {
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
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) { await b.bootstrap(); }
    await DI.resolve(Orm); // populates model descriptors' Columns from table info
  });

  afterEach(() => { DI.clearCache(); });

  it('translates a model instance on a FK column to its primary key value', () => {
    const owner = new Model4();
    owner.Id = 42;

    const m = new Model1();
    m.hydrate({ OwnerId: owner } as any);

    expect((m as any).OwnerId).to.equal(42);
  });

  it('still assigns a raw scalar FK value unchanged', () => {
    const m = new Model1();
    m.hydrate({ OwnerId: 7 } as any);

    expect((m as any).OwnerId).to.equal(7);
  });

  it('accepts a model instance under the relation name and sets the FK + relation', () => {
    const owner = new Model4();
    owner.Id = 9;

    const m = new Model1();
    m.hydrate({ Owner: owner } as any);

    expect((m.Owner as unknown as SingleRelation<Model4>).Value).to.equal(owner);
    expect((m as any).OwnerId).to.equal(9);
  });
});

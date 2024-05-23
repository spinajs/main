import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { MetaTest } from './mocks/models/MetaTest.js';

/* eslint-disable prettier/prettier */
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator } from './../src/hydrators.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import 'mocha';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeConverter, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, DatetimeValueConverter, TableQueryCompiler } from '../src/interfaces.js';
import * as sinon from 'sinon';
import { _modelProxyFactory } from './../src/model.js';
import './../src/bootstrap.js';
import { Orm } from '../src/orm.js';

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('Metadata', () => {
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
    DI.register(FakeConverter).as(DatetimeValueConverter);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  });

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  it('Should model convert value', async () => {});

  it('Should set meta in relation', async () => {
    await db();

    const m = new MetaTest();
    m.Metadata['test:meta'] = 1234;
    expect(m.Metadata['test:meta']).to.eq(1234);
  });

  it('Should delete meta in relation', async () => {

    await db();

    const m = new MetaTest();
    m.Metadata['test:meta'] = 1234;
    expect(m.Metadata['test:meta']).to.eq(1234);

    m.Metadata["test:meta"] = null;
    expect(m.Metadata['test:meta']).to.be.null;

  });

  it('Should set multiple meta', async () => {

    await db();

    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    m.Metadata['test:meta:*'] = 999;

    expect(m.Metadata['test:meta:aa']).to.eq(999);
    expect(m.Metadata['test:meta:a']).to.eq(999);
    expect(m.Metadata['test:meta:b']).to.eq(999);
    expect(m.Metadata['test:meta:c']).to.eq(999);
    expect(m.Metadata['test:meta:d']).to.eq(999);


  });

  it('Should delete multiple meta in relation', () => {

    
    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    m.Metadata['test:meta:*'] = null;

    expect(m.Metadata['test:meta:aa']).to.be.null;
    expect(m.Metadata['test:meta:a']).to.be.null;
    expect(m.Metadata['test:meta:b']).to.be.null;
    expect(m.Metadata['test:meta:c']).to.be.null;
    expect(m.Metadata['test:meta:d']).to.be.null;

    expect(m.Metadata.length).to.eq(0);

  });

  it('Should get multiple meta', () => {

    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    const ms = m.Metadata['test:meta:*'] as number[];
    expect(ms.length).to.equal(5);
    expect(ms[4]).to.equal(5);
  });
});

/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, QueryMiddleware } from '../src/interfaces.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator, OneToManyRelationHydrator } from '../src/hydrators.js';
import { Orm } from '../src/orm.js';
import { Model1 } from './mocks/models/Model1.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

const CALLS: string[] = [];

abstract class Recording extends QueryMiddleware {
  public afterQueryCreation(): void {
    CALLS.push(`after:${this.constructor.name}`);
  }

  public async beforeQueryExecution(): Promise<void> {
    CALLS.push(`before:${this.constructor.name}`);
  }
}

class Late extends Recording {
  public order = 1000;
}

class Default extends Recording {}

class Early extends Recording {
  public order = 100;
}

class AlsoEarly extends Recording {
  public order = 100;
}

class NotANumber extends Recording {
  public order = Number.NaN;
}

const OWN = [Late, Default, Early, AlsoEarly, NotANumber];

describe('Query middleware order', () => {
  beforeEach(async () => {
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
    DI.register(JunctionModelPropertyHydrator).as(ModelHydrator);
    DI.register(OneToManyRelationHydrator).as(ModelHydrator);

    // Registered after the 1000 one on purpose: DI order must not decide.
    for (const m of OWN) DI.register(m).as(QueryMiddleware);

    DI.removeAllListeners('di.resolved.Configuration');

    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper)) as Bootstrapper[];
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);

    CALLS.length = 0;
  });

  afterEach(() => {
    sinon.restore();
    for (const m of OWN) DI.unregister(m);
    DI.clearCache();
  });

  const own = (phase: string) => CALLS.filter((c) => c.startsWith(`${phase}:`)).map((c) => c.slice(phase.length + 1));

  it('defaults to 0', () => {
    expect(new Default().order).to.equal(0);
  });

  it('runs afterQueryCreation in ascending order, ties and non-numbers as registered', () => {
    Model1.select();

    expect(own('after')).to.eql(['Default', 'NotANumber', 'Early', 'AlsoEarly', 'Late']);
  });

  it('runs beforeQueryExecution in the same order', async () => {
    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(Promise.resolve([]));

    await Model1.select();

    expect(own('before')).to.eql(['Default', 'NotANumber', 'Early', 'AlsoEarly', 'Late']);
  });
});

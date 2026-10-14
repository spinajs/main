/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, QueryMiddleware, QueryContext } from '../src/interfaces.js';
import type { ITransactionContext } from '../src/interfaces.js';
import { QueryBuilder } from '../src/builders.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator, OneToManyRelationHydrator } from '../src/hydrators.js';
import { Orm } from '../src/orm.js';
import { Model1 } from './mocks/models/Model1.js';
import { RawModel } from './mocks/models/RawModel.js';
import '../src/bootstrap.js';
import '@spinajs/log';

chai.use(chaiAsPromised);
const expect = chai.expect;

/** Hook and driver calls in order, each with the transaction in scope when it ran. */
const CALLS: { what: string; tx: ITransactionContext | undefined }[] = [];
/** What the stubbed driver returns; after hooks must receive this very object. */
const ROWS: unknown[] = [];
const RESULTS: unknown[] = [];
const ASKED: QueryBuilder[] = [];
let failBefore = false;
let failAfter = false;
let driver: FakeSqliteDriver;

const record = (what: string): void => {
  CALLS.push({ what, tx: driver.CurrentTransaction });
};
const sequence = (): string[] => CALLS.map((c) => c.what);

const ALL_HOOKS = ['before:Plain', 'before:DeleteGuard', 'before:Early', 'before:Late', 'execute', 'after:DeleteGuard', 'after:Early', 'after:Late'];

class Plain extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Plain');
  }
}

/** Asks for a transaction around deletes only. */
class DeleteGuard extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:DeleteGuard');
    if (failBefore) throw new Error('before hook failed');
  }

  public async afterQueryExecution(): Promise<void> {
    record('after:DeleteGuard');
    if (failAfter) throw new Error('after hook failed');
  }

  public transactional(query: QueryBuilder): boolean {
    ASKED.push(query);
    return query.QueryContext === QueryContext.Delete;
  }
}

class Early extends QueryMiddleware {
  public order = 100;

  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Early');
  }

  public async afterQueryExecution(): Promise<void> {
    record('after:Early');
  }
}

class Late extends QueryMiddleware {
  public order = 1000;

  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Late');
  }

  public async afterQueryExecution(_query: QueryBuilder, result: unknown): Promise<void> {
    record('after:Late');
    RESULTS.push(result);
  }
}

const OWN = [Plain, DeleteGuard, Early, Late];

describe('Query middleware afterQueryExecution and transactional', () => {
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

    for (const m of OWN) DI.register(m).as(QueryMiddleware);

    DI.removeAllListeners('di.resolved.Configuration');

    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper)) as Bootstrapper[];
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    const orm = await DI.resolve(Orm);
    driver = orm.Connections.get('sqlite') as FakeSqliteDriver;

    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async () => {
      record('execute');
      return ROWS;
    });

    CALLS.length = 0;
    RESULTS.length = 0;
    ASKED.length = 0;
    failBefore = false;
    failAfter = false;
  });

  afterEach(() => {
    sinon.restore();
    for (const m of OWN) DI.unregister(m);
    DI.clearCache();
  });

  const spies = () => ({
    begin: sinon.spy(driver as any, '_begin'),
    commit: sinon.spy(driver as any, '_commit'),
    rollback: sinon.spy(driver as any, '_rollback'),
    savepoint: sinon.spy(driver as any, '_savepoint'),
  });

  it('leaves both new members optional', () => {
    const plain = new Plain();

    expect(plain.afterQueryExecution).to.equal(undefined);
    expect(plain.transactional).to.equal(undefined);
  });

  it('runs afterQueryExecution after the driver, in the order of beforeQueryExecution, with the raw result', async () => {
    await Model1.select();

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(RESULTS).to.have.length(1);
    expect(RESULTS[0]).to.equal(ROWS);
  });

  it('opens no transaction when no middleware asks for one', async () => {
    const s = spies();

    await Model1.select();

    expect(s.begin.called).to.equal(false);
    expect(CALLS.every((c) => c.tx === undefined)).to.equal(true);
    expect(ASKED).to.have.length(1);
    expect(ASKED[0].QueryContext).to.equal(QueryContext.Select);
  });

  it('runs before hooks, the statement and after hooks in one transaction when a middleware asks for it', async () => {
    const s = spies();

    await RawModel.destroy(1);

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(s.begin.calledOnce).to.equal(true);
    expect(s.commit.calledOnce).to.equal(true);
    expect(s.rollback.called).to.equal(false);
    expect(CALLS[0].tx).to.not.equal(undefined);
    expect(CALLS.every((c) => c.tx === CALLS[0].tx)).to.equal(true);
    expect(driver.CurrentTransaction).to.equal(undefined);
    expect(ASKED).to.have.length(1);
    expect(ASKED[0].QueryContext).to.equal(QueryContext.Delete);
    expect(RESULTS[0]).to.equal(ROWS);
  });

  it('rolls the transaction back and rejects when an after hook throws', async () => {
    const s = spies();
    failAfter = true;

    await expect(RawModel.destroy(1)).to.be.rejectedWith('after hook failed');

    expect(sequence()).to.eql(ALL_HOOKS.slice(0, 6));
    expect(s.rollback.calledOnce).to.equal(true);
    expect(s.commit.called).to.equal(false);
  });

  it('rolls the transaction back without running the statement when a before hook throws', async () => {
    const s = spies();
    failBefore = true;

    await expect(RawModel.destroy(1)).to.be.rejectedWith('before hook failed');

    expect(sequence()).to.eql(['before:Plain', 'before:DeleteGuard']);
    expect(s.rollback.calledOnce).to.equal(true);
    expect(s.commit.called).to.equal(false);
  });

  it('joins a caller transaction without a savepoint and without asking transactional', async () => {
    const s = spies();
    const seen: { outer?: ITransactionContext } = {};

    await driver.transaction(async () => {
      seen.outer = driver.CurrentTransaction;
      await RawModel.destroy(1);
    });

    expect(seen.outer).to.not.equal(undefined);
    expect(sequence()).to.eql(ALL_HOOKS);
    expect(CALLS.every((c) => c.tx === seen.outer)).to.equal(true);
    expect(s.begin.calledOnce).to.equal(true);
    expect(s.savepoint.called).to.equal(false);
    expect(s.commit.calledOnce).to.equal(true);
    expect(ASKED).to.have.length(0);
  });

  it('cannot roll anything back when no middleware asked for a transaction', async () => {
    const s = spies();
    failAfter = true;

    await expect(Model1.select()).to.be.rejectedWith('after hook failed');

    expect(sequence()).to.include('execute');
    expect(s.begin.called).to.equal(false);
    expect(s.rollback.called).to.equal(false);
  });

  it('runs the hooks and the transaction once when a builder is awaited twice', async () => {
    const s = spies();
    const query = RawModel.destroy(1);

    await query;
    await query;

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(s.begin.calledOnce).to.equal(true);
  });
});

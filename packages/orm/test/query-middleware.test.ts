/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, QueryMiddleware } from '../src/interfaces.js';
import { QueryBuilder } from '../src/builders.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator, OneToManyRelationHydrator } from '../src/hydrators.js';
import { Orm } from '../src/orm.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { RelationModel1 } from './mocks/models/RelationModel1.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

/**
 * Every model a query middleware was handed, in call order.
 *
 * A middleware is the enforcement point for cross-cutting query rules — rbac ownership is
 * the one in tree — so "how many times, and for which model" is a behavioural contract, not
 * an implementation detail. A hook that runs twice runs its side effects twice, and a hook
 * that runs against a builder which does not select from its model's table constrains the
 * wrong table.
 */
const SEEN: string[] = [];

@Injectable(QueryMiddleware)
export class RecordingMiddleware extends QueryMiddleware {
  public afterQueryCreation(query: QueryBuilder): void {
    SEEN.push(query.Model ? extractModelDescriptor(query.Model)!.Name : '<no model>');
  }

  public async beforeQueryExecution(): Promise<void> { }
}

describe('Query middlewares', () => {
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

    DI.removeAllListeners('di.resolved.Configuration');

    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper)) as Bootstrapper[];
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);

    SEEN.length = 0;
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('runs once for a plain select', () => {
    Model1.select();

    expect(SEEN).to.eql(['Model1']);
  });

  // `clone()` is not exercised here: this package resolves the ABSTRACT statement classes when
  // it runs on its own, and those have no `clone()` — only `orm-sql`'s concrete ones do. The
  // clone case is asserted over real statements in the rbac suite instead
  // ( `rbac-hooks.test.ts`, "a hook runs exactly once per query" ).

  it('runs once per populated belongsTo relation', () => {
    RelationModel1.select().populate('Owner');

    expect(SEEN).to.eql(['RelationModel1', 'RelationModel2']);
  });

  /**
   * A hasManyToMany relation is served by TWO builders: `_relationQuery`, which selects FROM
   * the target table, and `_joinQuery`, which selects FROM the JUNCTION table while carrying
   * the target model ( it needs the target model for hydration ). `compile()` then folds
   * `_relationQuery` into `_joinQuery`.
   *
   * Only `_relationQuery` may be shown to the middlewares. Running them on `_joinQuery` too
   * meant a rule for the target model was evaluated a second time against a builder whose FROM
   * is the junction table — so a constraint on a target column compiled to
   * `junction_table.target_column`, a column that does not exist. Models in the wild worked
   * around it by deferring the constraint with `Lazy` and bailing out on a table-name check.
   */
  it('runs once per populated hasManyToMany relation, on the query that selects from the target table', () => {
    Model4.select().populate('ManyOwners');

    expect(SEEN).to.eql(['Model4', 'Model5']);
  });
});

/* eslint-disable @typescript-eslint/no-floating-promises */
/**
 * Regression guard for I1 / B2 — the per-statement WHERE connector landed in `00a81987f`.
 *
 * `.where(a).orWhere(b).where(c)` used to compile to `a OR b OR c`, because a single
 * builder-level `_boolean` flag was applied to every statement in scope and the LAST call
 * won retroactively. It now compiles to `a OR b AND c`: each statement carries the connector
 * it was pushed with.
 *
 * `@spinajs/orm-http` is the heaviest consumer of the WHERE surface — it translates request
 * DTOs straight into filter chains — so this file pins the SQL its translation produces.
 *
 * NOTE: this suite deliberately boots ONLY the ORM, not the HTTP server. `orm-http.test.ts`
 * cannot bootstrap in this worktree (its `before all` dies resolving `fsService` /
 * `__file_provider_instance__`), and that failure is unrelated to the WHERE connector.
 * Testing the filter translation through a real SQLite compiler needs none of the HTTP stack.
 */
import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm, ModelBase, Model, Connection, Primary, SelectQueryBuilder } from '@spinajs/orm';

// Registers the `orm-driver-sqlite` driver in DI.
import '@spinajs/orm-sqlite';
// Declares IModelDescriptor.FilterableColumns; decorators.ts does not import it itself.
import '../src/extension.js';
import { Filterable } from '../src/decorators.js';
import { FilterableLogicalOperators, IFilter } from '../src/interfaces.js';

// Installs the `filter()` extension onto SelectQueryBuilder.prototype.
import '../src/builders.js';
import { MODEL_STATIC_MIXINS } from '../src/model.js';

@Connection('sqlite')
@Model('filter_regression')
class FilterRegressionModel extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'gt', 'lt', 'like'])
  public Age: number;

  @Filterable(['eq'])
  public Active: boolean;

  @Filterable(['eq'])
  public Role: string;
}

export class FilterTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: {
        targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: false },
          },
        ],
      },
    };
  }
}

function q(): SelectQueryBuilder<any> {
  return FilterRegressionModel.query() as unknown as SelectQueryBuilder<any>;
}

function f(Column: string, Operator: any, Value?: any): IFilter {
  return { Column, Operator, Value } as IFilter;
}

describe('orm-http filter translation vs the per-statement connector (I1/B2)', () => {
  before(async () => {
    DI.register(FilterTestConfiguration).as(Configuration);
    await DI.resolve(Orm);

    // `@spinajs/orm-http`'s bootstrapper installs these onto every loaded model; do the same
    // for the local fixture so `filter()` resolves its filterable columns exactly as in prod.
    for (const mixin in MODEL_STATIC_MIXINS) {
      (FilterRegressionModel as any)[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(FilterRegressionModel);
    }
  });

  after(() => {
    DI.clearCache();
  });

  it('a mixed AND/OR chain groups per statement, not retroactively', () => {
    const out = q().where('Age', '>', 18).where('Active', true).orWhere('Role', 'admin').toDB();

    // Before 00a81987f this was `Age > ? OR Active = ? OR Role = ?` — the trailing orWhere
    // rewrote the connector of every earlier statement.
    expect(out.expression).to.contain('`Age` > ? AND `Active` = ? OR `Role` = ?');
    // `true` binds as 1: the SQLite driver's boolean converter runs before binding.
    expect(out.bindings).to.deep.equal([18, 1, 'admin']);
  });

  it('a leading orWhere does not emit a dangling OR', () => {
    const out = q().orWhere('Age', 18).orWhere('Role', 'admin').toDB();

    expect(out.expression).to.contain('`Age` = ? OR `Role` = ?');
    expect(out.expression).to.not.match(/WHERE\s+OR/);
    expect(out.bindings).to.deep.equal([18, 'admin']);
  });

  it('filter() in AND mode produces a pure conjunction inside one group', () => {
    const filters = [f('Age', 'gt', 18), f('Active', 'eq', true), f('Role', 'eq', 'admin')];
    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    // orm-http wraps the whole filter set in a single andWhere(...) group, so the group is
    // isolated from anything else on the query and the connector change cannot leak into it.
    expect(out.expression).to.contain('( `Age` > ? AND `Active` = ? AND `Role` = ? )');
    // `true` binds as 1: the SQLite driver's boolean converter runs before binding.
    expect(out.bindings).to.deep.equal([18, 1, 'admin']);
  });

  it('filter() in OR mode produces a pure disjunction inside one group', () => {
    const filters = [f('Age', 'gt', 18), f('Active', 'eq', true), f('Role', 'eq', 'admin')];
    const out = (q() as any).filter(filters, FilterableLogicalOperators.Or).toDB();

    expect(out.expression).to.contain('( `Age` > ? OR `Active` = ? OR `Role` = ? )');
    // `true` binds as 1: the SQLite driver's boolean converter runs before binding.
    expect(out.bindings).to.deep.equal([18, 1, 'admin']);
  });

  it('a filter group stays AND-joined to a where outside it', () => {
    const filters = [f('Age', 'gt', 18), f('Role', 'eq', 'admin')];
    const out = (q().where('Id', 5) as any).filter(filters, FilterableLogicalOperators.Or).toDB();

    // The pre-existing `Id = ?` must remain ANDed to the OR group, not absorbed into it.
    expect(out.expression).to.contain('`Id` = ? AND ( `Age` > ? OR `Role` = ? )');
    expect(out.bindings).to.deep.equal([5, 18, 'admin']);
  });

  it('an explicitly wrapped group is the documented migration for the old behaviour', () => {
    const out = q()
      .where(function (this: any) {
        this.where('Age', 18).where('Active', true);
      })
      .orWhere('Role', 'admin')
      .toDB();

    expect(out.expression).to.contain('( `Age` = ? AND `Active` = ? ) OR `Role` = ?');
    // `true` binds as 1: the SQLite driver's boolean converter runs before binding.
    expect(out.bindings).to.deep.equal([18, 1, 'admin']);
  });
});

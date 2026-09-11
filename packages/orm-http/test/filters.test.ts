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
import AjvModule from 'ajv';
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

  it('applies a nested group as one bracketed condition, ANDed to its siblings', () => {
    // The multi-column search case: one text matched against several columns, while the filter
    // narrowing the pool keeps ANDing. Flattening the group would turn that AND into an OR and
    // widen the result to every row in every pool.
    const filters = [
      f('Role', 'eq', 'admin'),
      {
        op: FilterableLogicalOperators.Or,
        filters: [f('Age', 'eq', 18), f('Active', 'eq', true)],
      },
    ];

    const out = (q() as any)
      .filter(filters, FilterableLogicalOperators.And)
      .toDB();

    expect(out.expression).to.contain('`Role` = ? AND ( `Age` = ? OR `Active` = ? )');
    expect(out.bindings).to.deep.equal(['admin', 18, 1]);
  });

  it('rejects a group whose column is not filterable, like any other condition', () => {
    const filters = [
      {
        op: FilterableLogicalOperators.Or,
        filters: [f('Secret', 'eq', 'x')],
      },
    ];

    expect(() =>
      (q() as any).filter(filters, FilterableLogicalOperators.And).toDB(),
    ).to.throw(/not filterable/);
  });

  it('ORs a group against its siblings when the outer level is OR', () => {
    // The outer operator decides how the group JOINS the list; the group's own decides what
    // happens inside it. Mixing the two up is the easy mistake here.
    const filters = [
      f('Role', 'eq', 'admin'),
      {
        op: FilterableLogicalOperators.And,
        filters: [f('Age', 'gt', 18), f('Active', 'eq', true)],
      },
    ];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.Or).toDB();

    expect(out.expression).to.contain('`Role` = ? OR ( `Age` > ? AND `Active` = ? )');
    expect(out.bindings).to.deep.equal(['admin', 18, 1]);
  });

  it('defaults a group with no operator to AND, like the top level', () => {
    const filters = [
      {
        filters: [f('Age', 'gt', 18), f('Role', 'eq', 'admin')],
      },
    ];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    expect(out.expression).to.contain('( `Age` > ? AND `Role` = ? )');
    expect(out.bindings).to.deep.equal([18, 'admin']);
  });

  it('keeps two groups independent of each other', () => {
    // The shape a search produces once a second multi-column condition joins it.
    const filters = [
      {
        op: FilterableLogicalOperators.Or,
        filters: [f('Age', 'eq', 18), f('Age', 'eq', 21)],
      },
      {
        op: FilterableLogicalOperators.Or,
        filters: [f('Role', 'eq', 'admin'), f('Role', 'eq', 'editor')],
      },
    ];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    expect(out.expression).to.contain('( `Age` = ? OR `Age` = ? ) AND ( `Role` = ? OR `Role` = ? )');
    expect(out.bindings).to.deep.equal([18, 21, 'admin', 'editor']);
  });

  it('leaves a group holding a single condition unbracketed in effect', () => {
    // One searched column is the degenerate case of the same shape - it has to behave like a
    // plain condition rather than throw or drop out.
    const filters = [
      f('Role', 'eq', 'admin'),
      { op: FilterableLogicalOperators.Or, filters: [f('Age', 'gt', 18)] },
    ];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    expect(out.expression).to.contain('`Role` = ?');
    expect(out.expression).to.contain('`Age` > ?');
    expect(out.bindings).to.deep.equal(['admin', 18]);
  });

  it('ignores an empty group instead of emitting a bare pair of brackets', () => {
    const filters = [f('Role', 'eq', 'admin'), { op: FilterableLogicalOperators.Or, filters: [] }];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    expect(out.expression).to.contain('`Role` = ?');
    expect(out.expression).to.not.match(/\(\s*\)/);
    expect(out.bindings).to.deep.equal(['admin']);
  });

  it('rejects an operator the column does not allow, inside a group too', () => {
    // `Role` is @Filterable(['eq']) - nesting must not become a way around that.
    const filters = [
      {
        op: FilterableLogicalOperators.Or,
        filters: [f('Role', 'like', 'adm')],
      },
    ];

    expect(() =>
      (q() as any).filter(filters, FilterableLogicalOperators.And).toDB(),
    ).to.throw(/not allowed for column/);
  });

  it('applies a group nested inside another group', () => {
    // The builder walks whatever arrives; the schema only advertises one level, so this pins the
    // runtime half rather than the contract.
    const filters = [
      {
        op: FilterableLogicalOperators.Or,
        filters: [
          f('Age', 'eq', 18),
          {
            op: FilterableLogicalOperators.And,
            filters: [f('Role', 'eq', 'admin'), f('Active', 'eq', true)],
          },
        ],
      },
    ];

    const out = (q() as any).filter(filters, FilterableLogicalOperators.And).toDB();

    expect(out.expression).to.contain('`Age` = ? OR ( `Role` = ? AND `Active` = ? )');
    expect(out.bindings).to.deep.equal([18, 'admin', 1]);
  });
});

/**
 * The schema half. `filter()` above proves the builder can execute a nested group; this proves the
 * validator lets one through in the first place - the two failed independently, and the reported
 * bug was the schema rejecting a payload the builder would have handled fine.
 */
describe('orm-http filter schema accepts what the builder executes', () => {
  // ajv is CommonJS; under this tsconfig the constructor sits on `.default`.
  const Ajv = ((AjvModule as any).default ?? AjvModule) as new (o?: unknown) => {
    validate: (schema: unknown, data: unknown) => boolean;
  };

  const validate = (filter: unknown): boolean => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    return ajv.validate(
      (FilterRegressionModel as any).filterSchema(),
      filter,
    ) as boolean;
  };

  it('accepts a nested OR group beside a plain condition', () => {
    // The exact shape a multi-column search sends: one condition narrowing the set, and a group
    // ORing the searched columns. Every `anyOf` variant used to require `Column`/`Operator`,
    // which a group has neither of, so this answered 400 and the search could not be built.
    expect(
      validate({
        op: 'and',
        filters: [
          { Column: 'Role', Operator: 'eq', Value: 'admin' },
          {
            op: 'or',
            filters: [
              { Column: 'Age', Operator: 'like', Value: 'FAKE' },
              { Column: 'Role', Operator: 'eq', Value: 'FAKE' },
            ],
          },
        ],
      }),
    ).to.equal(true);
  });

  it('accepts a flat list, unchanged', () => {
    expect(
      validate({
        op: 'and',
        filters: [{ Column: 'Age', Operator: 'gt', Value: 18 }],
      }),
    ).to.equal(true);
  });

  it('rejects an operator the column does not allow, inside a group', () => {
    // `Role` is @Filterable(['eq']); nesting must not be a way around that.
    expect(
      validate({
        op: 'and',
        filters: [
          {
            op: 'or',
            filters: [{ Column: 'Role', Operator: 'like', Value: 'x' }],
          },
        ],
      }),
    ).to.equal(false);
  });

  it('rejects a column that is not filterable, inside a group', () => {
    expect(
      validate({
        op: 'and',
        filters: [
          {
            op: 'or',
            filters: [{ Column: 'Secret', Operator: 'eq', Value: 'x' }],
          },
        ],
      }),
    ).to.equal(false);
  });
});

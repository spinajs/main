import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm, ModelBase, Model, Connection, Primary, ISelectQueryBuilder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import '@spinajs/orm-sqlite';
import '../src/extension.js';
import { Filterable } from '../src/decorators.js';
import { FilterableLogicalOperators, IFilter } from '../src/interfaces.js';
import '../src/builders.js';
import { MODEL_STATIC_MIXINS } from '../src/model.js';

@Connection('sqlite')
@Model('filter_between')
class FilterBetweenModel extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'between', 'notbetween'])
  public N: number;
}

class FilterBetweenConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: {
        StrictTableCheck: false,
        MigrationCheck: 'off',
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations' },
          },
        ],
      },
    };
  }
}

function filter(Column: string, Operator: IFilter['Operator'], Value: unknown): IFilter {
  return { Column, Operator, Value };
}

async function selectN(filters: IFilter[], op: FilterableLogicalOperators): Promise<number[]> {
  const rows = await (FilterBetweenModel.query() as ISelectQueryBuilder<FilterBetweenModel[]>).filter(filters, op).orderBy('N');
  return rows.map((r) => r.N);
}

describe('orm-http between filter', function () {
  this.timeout(10000);

  before(async () => {
    DI.clearCache();
    DI.register(FilterBetweenConfiguration).as(Configuration);
    const orm = await DI.resolve(Orm);

    // The orm-http bootstrapper installs these onto every loaded model.
    for (const [name, mixin] of Object.entries(MODEL_STATIC_MIXINS)) {
      Object.defineProperty(FilterBetweenModel, name, { value: mixin.bind(FilterBetweenModel), configurable: true, writable: true });
    }

    const connection = orm.Connections.get('sqlite')!;
    await connection.schema().createTable('filter_between', (table) => {
      table.int('Id').primaryKey();
      table.int('N');
    });
    await orm.reloadTableInfo();
    for (let n = 1; n <= 6; n++) {
      await FilterBetweenModel.insert({ Id: n, N: n * 10 });
    }
  });

  // No DI.clearCache() afterwards: filters.test.ts, later in the glob, boots without MigrationCheck 'off' and
  // relies on finding an Orm already resolved by a preceding suite.

  it('between returns exactly the rows in the closed range', async () => {
    expect(await selectN([filter('N', 'between', [20, 40])], FilterableLogicalOperators.And)).to.deep.equal([20, 30, 40]);
  });

  it('between under op "or" returns the union with the other filter', async () => {
    expect(await selectN([filter('N', 'between', [20, 30]), filter('N', 'eq', 60)], FilterableLogicalOperators.Or)).to.deep.equal([20, 30, 60]);
  });

  it('notbetween returns the rows outside the range', async () => {
    expect(await selectN([filter('N', 'notbetween', [20, 50])], FilterableLogicalOperators.And)).to.deep.equal([10, 60]);
  });

  it('refuses a value that is not exactly two values', () => {
    const query = () => (FilterBetweenModel.query() as ISelectQueryBuilder<FilterBetweenModel[]>);
    expect(() => query().filter([filter('N', 'between', [10, 20, 30])], FilterableLogicalOperators.And)).to.throw(InvalidArgument, /exactly 2 values/);
    expect(() => query().filter([filter('N', 'between', [10])], FilterableLogicalOperators.And)).to.throw(InvalidArgument, /exactly 2 values/);
  });
});

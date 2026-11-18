import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Connection, IWhereBuilder, Model, ModelBase, Primary } from '@spinajs/orm';
import '../src/extension.js';
import { Filterable } from '../src/decorators.js';
import { installFilterStatics } from './filter-statics.js';
import { bootListFixture, Customer, Order } from './list-fixture.js';

@Connection('default')
@Model('lq_order')
class OrderWithSearch extends ModelBase {
  @Primary()
  @Filterable(['eq'])
  public Id: number;

  @Filterable(['like'], (_operator, value) => function (this: IWhereBuilder<unknown>) {
    this.where('Note', 'like', `%${value}%`);
  })
  public search: string;

  @Filterable(Customer)
  public Customer: unknown;
}

describe('sortableColumns()', function () {
  this.timeout(15000);

  before(async () => {
    await bootListFixture();
    installFilterStatics(OrderWithSearch);
  });
  after(() => DI.clearCache());

  it('is exactly the @Sortable columns when the model declares any', () => {
    expect(Order.sortableColumns()).to.have.members(['Id', 'Status', 'Amount']);
  });

  it('falls back to the filterable columns of the table when the model declares none', () => {
    expect(Customer.sortableColumns()).to.have.members(['Name']);
  });

  it('the fallback leaves out filter-only and relation columns', () => {
    expect(OrderWithSearch.sortableColumns()).to.deep.equal(['Id']);
  });
});

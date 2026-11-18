import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BelongsTo, Connection, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import '../src/extension.js';
import { Filterable, FilterGroupDepth } from '../src/decorators.js';
import { FilterableLogicalOperators, IFilterEntry, MAX_FILTER_GROUP_DEPTH } from '../src/interfaces.js';
import { filterSchemaFor } from '../src/model.js';
import { MAX_FILTERS } from '../src/builders.js';
import { installFilterStatics } from './filter-statics.js';
import { bootListFixture, compileSchema, Customer, idsOf, Order } from './list-fixture.js';

@Connection('default')
@Model('lq_order')
@FilterGroupDepth(3)
class DeepOrder extends ModelBase {
  @Primary()
  @Filterable(['eq'])
  public Id: number;

  @Filterable(['eq'])
  public Status: string;

  @Filterable(['gte'])
  public Amount: number;

  @Filterable(['nlike', 'isnull'])
  public Note: string;

  @Filterable(['gt'], null, true)
  public Total: number;

  @BelongsTo(Customer, 'CustomerId')
  @Filterable(Customer)
  public Customer: SingleRelation<Customer>;
}

const validator = (model: typeof ModelBase) => compileSchema(model.filterSchema());

const OPEN: IFilterEntry = { Column: 'Status', Operator: 'eq', Value: 'open' };

/** `levels` groups, each holding the next, around one condition. */
function nested(levels: number, not = false): { filters: IFilterEntry[] } {
  let entry: IFilterEntry = OPEN;
  for (let level = 0; level < levels; level++) {
    entry = { op: FilterableLogicalOperators.Or, ...(not ? { not: true } : {}), filters: [entry] };
  }
  return { filters: [entry] };
}

const refusal = (model: typeof ModelBase, filters: IFilterEntry[]) => () => {
  model.query().filter(filters);
};

describe('filter groups nested deeper than one level', function () {
  this.timeout(15000);

  before(async () => {
    await bootListFixture();
    installFilterStatics(DeepOrder);
  });
  after(() => DI.clearCache());

  it('a model that does not opt in keeps one level', () => {
    const validate = validator(Order);
    expect(validate(nested(1))).to.equal(true);
    expect(validate(nested(1, true))).to.equal(true);
    expect(validate(nested(2))).to.equal(false);
  });

  it('filterSchemaFor without a depth builds the depth 1 schema, byte for byte', () => {
    // The literal shape is pinned by test/orm-http.test.ts, "Should return filterable columns schema".
    const columns = Order.filterColumns();
    const descriptor = Order.getModelDescriptor();
    expect(JSON.stringify(filterSchemaFor(columns))).to.equal(JSON.stringify(filterSchemaFor(columns, undefined, 1)));
    expect(JSON.stringify(Order.filterSchema())).to.equal(JSON.stringify(filterSchemaFor(columns, descriptor, 1)));
  });

  it('a model opted in to depth 3 accepts three levels and refuses four', () => {
    const validate = validator(DeepOrder);
    expect(validate(nested(2))).to.equal(true);
    expect(validate(nested(3))).to.equal(true);
    expect(validate(nested(4))).to.equal(false);
  });

  it('allows not on a group at every level', () => {
    expect(validator(DeepOrder)(nested(3, true))).to.equal(true);
  });

  it('refuses a depth outside 1 to MAX_FILTER_GROUP_DEPTH', () => {
    const columns = [{ column: 'Status', operators: ['eq' as const] }];
    expect(MAX_FILTER_GROUP_DEPTH).to.equal(4);
    expect(() => filterSchemaFor(columns, undefined, MAX_FILTER_GROUP_DEPTH)).to.not.throw();
    expect(() => filterSchemaFor(columns, undefined, MAX_FILTER_GROUP_DEPTH + 1)).to.throw(InvalidOption);
    expect(() => filterSchemaFor(columns, undefined, 0)).to.throw(InvalidOption);
    expect(() => FilterGroupDepth(MAX_FILTER_GROUP_DEPTH + 1)).to.throw(/FilterGroupDepth/);
    expect(() => FilterGroupDepth(1.5)).to.throw(/FilterGroupDepth/);
  });

  it('the builder returns the rows of A and (B or (not-like C or isnull C))', async () => {
    const request: { filters: IFilterEntry[] } = {
      filters: [
        { Column: 'Amount', Operator: 'gte', Value: 60 },
        {
          op: FilterableLogicalOperators.Or,
          filters: [
            { Column: 'Status', Operator: 'eq', Value: 'paid' },
            {
              op: FilterableLogicalOperators.Or,
              filters: [
                { Column: 'Note', Operator: 'nlike', Value: 'urgent' },
                { Column: 'Note', Operator: 'isnull', Value: undefined },
              ],
            },
          ],
        },
      ],
    };

    expect(validator(Order)(request)).to.equal(false);
    expect(validator(DeepOrder)(structuredClone(request))).to.equal(true);
    expect(idsOf(await Order.query().filter(request.filters))).to.deep.equal([2, 4, 5]);
  });

  it('negation applies at every level of the builder', async () => {
    expect(idsOf(await Order.query().filter(nested(2, true).filters))).to.deep.equal([1, 3, 4]);
    expect(idsOf(await Order.query().filter(nested(3, true).filters))).to.deep.equal([2, 5]);
  });

  it('a relation or aggregate column inside a nested negated group is refused', () => {
    const inNegated = (leaf: IFilterEntry): IFilterEntry[] => [{ filters: [{ not: true, filters: [leaf] }] }];
    expect(refusal(DeepOrder, inNegated({ Column: 'Customer.Name', Operator: 'eq', Value: 'acme' }))).to.throw(InvalidArgument, /whole query/);
    expect(refusal(DeepOrder, inNegated({ Column: 'Total', Operator: 'gt', Value: 1 }))).to.throw(InvalidArgument, /whole query/);
  });

  describe('MAX_FILTERS counts the entries at every depth', () => {
    const conditions = (count: number): IFilterEntry[] => Array.from({ length: count }, () => OPEN);

    it('refuses a group that carries more than MAX_FILTERS conditions', () => {
      expect(refusal(Order, [{ filters: conditions(MAX_FILTERS) }])).to.throw(InvalidArgument, `Maximum allowed: ${MAX_FILTERS}`);
    });

    it('refuses nested groups whose entries add up to more than MAX_FILTERS', () => {
      const filters: IFilterEntry[] = [...conditions(40), { filters: [...conditions(30), { filters: conditions(30) }] }];
      expect(refusal(DeepOrder, filters)).to.throw(InvalidArgument, /102/);
    });

    it('accepts MAX_FILTERS entries, groups included', () => {
      const filters: IFilterEntry[] = [...conditions(MAX_FILTERS - 2), { filters: [OPEN] }];
      expect(refusal(Order, filters)).to.not.throw();
    });
  });

  it('a relation column inside nested and-groups is still applied to the whole query', () => {
    const filters: IFilterEntry[] = [{ filters: [{ filters: [{ Column: 'Customer.Name', Operator: 'eq', Value: 'acme' }] }] }];
    expect(() => DeepOrder.query().filter(filters).toDB()).to.not.throw();
  });
});

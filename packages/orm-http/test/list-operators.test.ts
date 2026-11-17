import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FilterableLogicalOperators, IFilterEntry } from '../src/interfaces.js';
import { bootListFixture, compileSchema, idsOf, Order } from './list-fixture.js';

async function ids(filters: IFilterEntry[], op: FilterableLogicalOperators = FilterableLogicalOperators.And): Promise<number[]> {
  return idsOf(await Order.query().filter(filters, op));
}

const refusal = (filters: IFilterEntry[]) => () => {
  Order.query().filter(filters);
};

describe('filter(): negated and empty operators, group negation', function () {
  this.timeout(15000);

  before(bootListFixture);
  after(() => DI.clearCache());

  it('nlike keeps the rows whose text does not contain the value; rows without text are not matched', async () => {
    expect(await ids([{ Column: 'Note', Operator: 'nlike', Value: 'urgent' }])).to.deep.equal([3, 4]);
  });

  it('ne-like keeps the rows whose text does not start with the value', async () => {
    expect(await ids([{ Column: 'Note', Operator: 'ne-like', Value: 'call' }])).to.deep.equal([1, 3, 5]);
  });

  it('nb-like keeps the rows whose text does not end with the value', async () => {
    expect(await ids([{ Column: 'Note', Operator: 'nb-like', Value: 'first' }])).to.deep.equal([1, 3, 5]);
  });

  it('nlike matches its value literally: a percent sign is no wildcard', async () => {
    expect(await ids([{ Column: 'Note', Operator: 'nlike', Value: '%' }])).to.deep.equal([1, 3, 4, 5]);
  });

  it('empty matches null and empty text; nempty the rest', async () => {
    expect(await ids([{ Column: 'Note', Operator: 'empty', Value: undefined }])).to.deep.equal([2, 3]);
    expect(await ids([{ Column: 'Note', Operator: 'nempty', Value: undefined }])).to.deep.equal([1, 4, 5]);
  });

  it('the new operators work as alternatives of an or', async () => {
    const filters: IFilterEntry[] = [
      { Column: 'Status', Operator: 'eq', Value: 'paid' },
      { Column: 'Note', Operator: 'empty', Value: undefined },
    ];
    expect(await ids(filters, FilterableLogicalOperators.Or)).to.deep.equal([2, 3, 5]);
  });

  it('a negated group keeps the rows its conditions do not match', async () => {
    const filters: IFilterEntry[] = [
      {
        not: true,
        op: FilterableLogicalOperators.Or,
        filters: [
          { Column: 'Status', Operator: 'eq', Value: 'open' },
          { Column: 'Amount', Operator: 'gt', Value: 400 },
        ],
      },
    ];
    expect(await ids(filters)).to.deep.equal([2]);
  });

  it('a negated group is anded with the conditions beside it', async () => {
    const filters: IFilterEntry[] = [
      { Column: 'Amount', Operator: 'gte', Value: 100 },
      { not: true, filters: [{ Column: 'Status', Operator: 'eq', Value: 'paid' }] },
    ];
    expect(await ids(filters)).to.deep.equal([1]);
  });

  it('refuses a new operator on a column that does not list it', () => {
    expect(refusal([{ Column: 'Status', Operator: 'nlike', Value: 'o' }])).to.throw(InvalidArgument);
  });

  it('refuses nlike without a text value', () => {
    expect(refusal([{ Column: 'Note', Operator: 'nlike', Value: '' }])).to.throw(InvalidArgument);
  });

  it('the filter schema accepts not on a group and the new operators, and nothing else new', () => {
    const validate = compileSchema(Order.filterSchema());

    expect(validate({ filters: [{ not: true, filters: [{ Column: 'Note', Operator: 'empty' }] }] })).to.equal(true);
    expect(validate({ filters: [{ Column: 'Note', Operator: 'nb-like', Value: 'x' }] })).to.equal(true);
    expect(validate({ filters: [{ not: 'yes', filters: [{ Column: 'Note', Operator: 'empty' }] }] })).to.equal(false);
    expect(validate({ filters: [{ Column: 'Status', Operator: 'nempty' }] })).to.equal(false);
  });
});

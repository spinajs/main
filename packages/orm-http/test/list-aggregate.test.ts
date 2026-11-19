import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, SortOrder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { IAggregateRequest, IFilterEntry } from '../src/interfaces.js';
import { MAX_AGGREGATE_ROWS, readAggregateRows } from '../src/aggregate.js';
import { bootListFixture, compileSchema, Customer, Order } from './list-fixture.js';

async function run(spec: IAggregateRequest, filters?: IFilterEntry[]): Promise<Record<string, unknown>[]> {
  const query = Order.query().filter(filters).aggregate(spec);
  return readAggregateRows(await query.asRaw<Record<string, unknown>[]>(), spec);
}

describe('aggregate()', function () {
  this.timeout(15000);

  before(bootListFixture);
  after(() => DI.clearCache());

  it('answers one row of totals without groupBy', async () => {
    const rows = await run({ measures: [{ name: 'total', fn: 'sum', column: 'Amount' }, { name: 'orders', fn: 'count' }] });
    expect(rows).to.deep.equal([{ total: 950, orders: 5 }]);
  });

  it('answers one row per group', async () => {
    const rows = await run({
      groupBy: ['Status'],
      measures: [{ name: 'total', fn: 'sum', column: 'Amount' }, { name: 'orders', fn: 'count' }],
      order: [{ column: 'Status', order: SortOrder.ASC }],
    });
    expect(rows).to.deep.equal([
      { Status: 'open', total: 200, orders: 3 },
      { Status: 'paid', total: 750, orders: 2 },
    ]);
  });

  it('groups by several columns', async () => {
    const rows = await run({
      groupBy: ['CustomerId', 'Status'],
      measures: [{ name: 'orders', fn: 'count' }],
      order: [{ column: 'CustomerId' }, { column: 'Status' }],
    });
    expect(rows).to.deep.equal([
      { CustomerId: 1, Status: 'open', orders: 1 },
      { CustomerId: 1, Status: 'paid', orders: 1 },
      { CustomerId: 2, Status: 'open', orders: 2 },
      { CustomerId: 3, Status: 'paid', orders: 1 },
    ]);
  });

  it('orders by a measure and keeps the first rows of limit', async () => {
    const rows = await run({
      groupBy: ['CustomerId'],
      measures: [{ name: 'owed', fn: 'sum', column: 'Amount' }],
      order: [{ column: 'owed', order: SortOrder.DESC }],
      limit: 2,
    });
    expect(rows).to.deep.equal([
      { CustomerId: 3, owed: 500 },
      { CustomerId: 1, owed: 350 },
    ]);
  });

  it('aggregates only the rows the filter keeps', async () => {
    const rows = await run({ measures: [{ name: 'low', fn: 'min', column: 'Amount' }, { name: 'high', fn: 'max', column: 'Amount' }, { name: 'mean', fn: 'avg', column: 'Amount' }] }, [
      { Column: 'Status', Operator: 'eq', Value: 'open' },
    ]);
    expect(rows[0].low).to.equal(40);
    expect(rows[0].high).to.equal(100);
    expect(rows[0].mean).to.be.closeTo(66.67, 0.01);
  });

  it('counts the values of a column when count names one', async () => {
    const rows = await run({ measures: [{ name: 'noted', fn: 'count', column: 'Amount' }] });
    expect(rows).to.deep.equal([{ noted: 5 }]);
  });

  describe('refuses', () => {
    const refused = (spec: unknown) =>
      expect(() => {
        Order.query().aggregate(spec as IAggregateRequest);
      }).to.throw(InvalidArgument);

    it('a group column that is not @Groupable', () => refused({ groupBy: ['Note'], measures: [{ name: 'n', fn: 'count' }] }));
    it('a function the column does not allow', () => refused({ measures: [{ name: 'n', fn: 'sum', column: 'CustomerId' }] }));
    it('a measure without a column, other than count', () => refused({ measures: [{ name: 'n', fn: 'sum' }] }));
    it('a relation path', () => refused({ groupBy: ['Customer.Name'], measures: [{ name: 'n', fn: 'count' }] }));
    it('a measure name that is no identifier', () => refused({ measures: [{ name: 'n; drop table lq_order', fn: 'count' }] }));
    it('two results with one name', () => refused({ groupBy: ['Status'], measures: [{ name: 'Status', fn: 'count' }] }));
    it('no measures', () => refused({ groupBy: ['Status'], measures: [] }));
    it('an order column that is neither a group nor a measure', () => refused({ groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }], order: [{ column: 'Amount' }] }));
  });

  it('clamps limit to the ceiling', () => {
    const out = Order.query()
      .aggregate({ groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }], limit: MAX_AGGREGATE_ROWS * 10 })
      .toDB() as ICompilerOutput;
    // The limit is inlined or bound, depending on the driver's compiler.
    const compiled = `${out.expression} ${(out.bindings ?? []).join(' ')}`;
    expect(compiled).to.contain(String(MAX_AGGREGATE_ROWS));
    expect(compiled).to.not.contain(String(MAX_AGGREGATE_ROWS * 10));
  });

  it('the schema names the allowed columns and functions', () => {
    const validate = compileSchema(Order.aggregateSchema());

    expect(validate({ groupBy: ['Status'], measures: [{ name: 'total', fn: 'sum', column: 'Amount' }] })).to.equal(true);
    expect(validate({ groupBy: ['Note'], measures: [{ name: 'n', fn: 'count' }] })).to.equal(false);
    expect(validate({ measures: [{ name: 'n', fn: 'median', column: 'Amount' }] })).to.equal(false);
    expect(validate({ measures: [] })).to.equal(false);
    expect(validate({ measures: [{ name: 'n', fn: 'count' }], extra: true })).to.equal(false);
  });

  describe('a model without @Groupable or @Aggregatable columns', () => {
    it('has a schema that compiles and accepts only a count of rows', () => {
      const validate = compileSchema(Customer.aggregateSchema());

      expect(validate({ measures: [{ name: 'n', fn: 'count' }] })).to.equal(true);
      expect(validate({ measures: [{ name: 'n', fn: 'count', column: 'Name' }] })).to.equal(false);
      expect(validate({ groupBy: ['Name'], measures: [{ name: 'n', fn: 'count' }] })).to.equal(false);
    });

    it('counts its rows', async () => {
      const spec: IAggregateRequest = { measures: [{ name: 'n', fn: 'count' }] };
      expect(readAggregateRows(await Customer.query().aggregate(spec).asRaw<Record<string, unknown>[]>(), spec)).to.deep.equal([{ n: 3 }]);
    });

    it('refuses a column, naming the missing allow-list', () => {
      expect(() => Customer.query().aggregate({ groupBy: ['Name'], measures: [{ name: 'n', fn: 'count' }] })).to.throw(InvalidArgument, /no @Groupable column/);
      expect(() => Customer.query().aggregate({ measures: [{ name: 'n', fn: 'count', column: 'Name' }] })).to.throw(InvalidArgument, /no @Groupable or @Aggregatable column/);
    });
  });

  it('readAggregateRows turns numeric text into numbers and keeps other values', () => {
    const spec: IAggregateRequest = { groupBy: ['Status'], measures: [{ name: 'total', fn: 'sum', column: 'Amount' }, { name: 'first', fn: 'min', column: 'Note' }] };
    expect(readAggregateRows([{ Status: 'open', total: '200', first: 'call first' }], spec)).to.deep.equal([{ Status: 'open', total: 200, first: 'call first' }]);
  });
});

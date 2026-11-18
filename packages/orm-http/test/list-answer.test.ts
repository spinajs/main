import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { listResponseSchema } from '../src/dto.js';
import { readList } from '../src/list.js';
import { bootListFixture, compileSchema, Order } from './list-fixture.js';

const ids = (rows: Record<string, unknown>[]) => rows.map((row) => row.Id);

describe('readList', function () {
  this.timeout(15000);

  before(bootListFixture);
  after(() => DI.clearCache());

  it('answers every row in primary key order and the total when nothing is asked', async () => {
    const answer = await readList(Order);
    expect(ids(answer.rows)).to.deep.equal([1, 2, 3, 4, 5]);
    expect(answer.total).to.equal(5);
    expect(answer).to.not.have.property('aggregates');
  });

  it('filters, and counts the filtered rows', async () => {
    const answer = await readList(Order, { filter: { filters: [{ Column: 'Status', Operator: 'eq', Value: 'open' }] } });
    expect(ids(answer.rows)).to.deep.equal([1, 3, 4]);
    expect(answer.total).to.equal(3);
  });

  it('sorts by several columns, ties broken by the primary key', async () => {
    const answer = await readList(Order, { sorting: { by: [{ column: 'Status', order: 'DESC' }, { column: 'Amount', order: 'DESC' }] } });
    expect(ids(answer.rows)).to.deep.equal([5, 2, 1, 4, 3]);
  });

  it('pages after sorting; the total is of every matching row', async () => {
    const answer = await readList(Order, { pagination: { limit: 2, page: 1 }, sorting: { by: [{ column: 'Amount', order: 'ASC' }] } });
    expect(ids(answer.rows)).to.deep.equal([1, 2]);
    expect(answer.total).to.equal(5);
  });

  it('answers the aggregates of the filtered rows, whatever the page', async () => {
    const answer = await readList(Order, {
      filter: { filters: [{ Column: 'Status', Operator: 'eq', Value: 'open' }] },
      pagination: { limit: 1 },
      aggregate: { measures: [{ name: 'total', fn: 'sum', column: 'Amount' }] },
    });
    expect(answer.rows).to.have.length(1);
    expect(answer.aggregates).to.deep.equal([{ total: 200 }]);
  });

  it('answers the aggregates alone for a page of no rows', async () => {
    const answer = await readList(Order, { pagination: { limit: 0 }, aggregate: { groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }], order: [{ column: 'Status' }] } });
    expect(answer.rows).to.deep.equal([]);
    expect(answer.total).to.equal(5);
    expect(answer.aggregates).to.deep.equal([
      { Status: 'open', n: 3 },
      { Status: 'paid', n: 2 },
    ]);
  });

  it('loads the relations asked for', async () => {
    const answer = await readList(Order, { include: ['Customer'], pagination: { limit: 1 } });
    expect(answer.rows[0].Customer).to.include({ Name: 'acme' });
  });

  it('clamps the page to maxLimit', async () => {
    const answer = await readList(Order, { pagination: { limit: 500 } }, { maxLimit: 2 });
    expect(answer.rows).to.have.length(2);
  });

  it('refuses a sort column outside the model sortable columns', async () => {
    let error: unknown;
    try {
      await readList(Order, { sorting: { by: [{ column: 'Note' }] } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidArgument);
  });
});

describe('listResponseSchema', () => {
  const row = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };

  it('describes rows of the given schema, a total and optional aggregates', () => {
    const validate = compileSchema(listResponseSchema('test.OrderList', row));
    expect(validate({ rows: [{ id: 1 }], total: 1 })).to.equal(true);
    expect(validate({ rows: [{ id: 1 }], total: 1, aggregates: [{ total: 5 }] })).to.equal(true);
    expect(validate({ rows: [{ id: 'x' }], total: 1 })).to.equal(false);
    expect(validate({ rows: [] })).to.equal(false);
  });

  it('leaves aggregates out when the list has none', () => {
    const schema = listResponseSchema('test.PlainList', row, { aggregates: false });
    expect(schema.properties).to.not.have.property('aggregates');
    expect(schema.$id).to.equal('test.PlainList');
  });
});

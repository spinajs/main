import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { CanceledException } from '@spinajs/util';
import { FilterableLogicalOperators } from '../src/interfaces.js';
import { IListOptions, IListRequest, readList } from '../src/list.js';
import { bootListFixture, Order } from './list-fixture.js';

type Refusal = Error & { fieldName?: string; cause?: unknown };

const ids = (rows: Record<string, unknown>[]) => rows.map((row) => row.Id);

async function refusal(request: IListRequest, options: IListOptions): Promise<Refusal> {
  try {
    await readList(Order, request, options);
  } catch (e) {
    return e as Refusal;
  }
  throw new Error('readList answered instead of refusing');
}

const ofCustomer2 = (query: SelectQueryBuilder<any>) => {
  query.where('CustomerId', 2);
};

describe('readList options: scope, columns, signal', function () {
  this.timeout(15000);

  before(bootListFixture);
  after(() => DI.clearCache());

  describe('scope', () => {
    it('counts, pages and aggregates only the scoped rows', async () => {
      const answer = await readList(
        Order,
        { pagination: { limit: 1 }, aggregate: { measures: [{ name: 'total', fn: 'sum', column: 'Amount' }, { name: 'orders', fn: 'count' }] } },
        { scope: ofCustomer2 },
      );
      expect(ids(answer.rows)).to.deep.equal([3]);
      expect(answer.total).to.equal(2);
      expect(answer.aggregates).to.deep.equal([{ total: 100, orders: 2 }]);
    });

    it('is anded with the request filter', async () => {
      const answer = await readList(Order, { filter: { filters: [{ Column: 'Amount', Operator: 'gt', Value: 50 }] } }, { scope: ofCustomer2 });
      expect(ids(answer.rows)).to.deep.equal([4]);
      expect(answer.total).to.equal(1);
    });

    it('cannot be widened by an or filter', async () => {
      const answer = await readList(
        Order,
        {
          filter: {
            op: FilterableLogicalOperators.Or,
            filters: [
              { Column: 'Status', Operator: 'eq', Value: 'paid' },
              { Column: 'Amount', Operator: 'gt', Value: 0 },
            ],
          },
        },
        { scope: ofCustomer2 },
      );
      expect(ids(answer.rows)).to.deep.equal([3, 4]);
      expect(answer.total).to.equal(2);
    });

    it('stays one condition when it ors conditions of its own', async () => {
      const answer = await readList(
        Order,
        { filter: { filters: [{ Column: 'Status', Operator: 'eq', Value: 'paid' }] } },
        {
          scope: (query) => {
            query.where('CustomerId', 1).orWhere('CustomerId', 3);
          },
        },
      );
      expect(ids(answer.rows)).to.deep.equal([2, 5]);
      expect(answer.total).to.equal(2);
    });

    it('runs once per statement, on a builder of the model', async () => {
      const seen: unknown[] = [];
      await readList(
        Order,
        { aggregate: { measures: [{ name: 'n', fn: 'count' }] } },
        {
          scope: (query) => {
            seen.push((query as unknown as { _model: unknown })._model);
          },
        },
      );
      expect(seen).to.deep.equal([Order, Order, Order]);
    });
  });

  describe('columns', () => {
    const projection: IListOptions = { columns: ['Status'] };

    it('answers only the listed columns and the primary key', async () => {
      const answer = await readList(Order, { pagination: { limit: 2 } }, projection);
      expect(answer.rows).to.deep.equal([
        { Id: 1, Status: 'open' },
        { Id: 2, Status: 'paid' },
      ]);
    });

    it('filters and sorts by a listed column and by the primary key', async () => {
      const answer = await readList(
        Order,
        { filter: { filters: [{ Column: 'Id', Operator: 'in', Value: [1, 2, 3] }] }, sorting: { by: [{ column: 'Status', order: 'DESC' }] } },
        projection,
      );
      expect(ids(answer.rows)).to.deep.equal([2, 1, 3]);
    });

    it('refuses a filter on a column outside the list, at the top level and inside a group', async () => {
      const top = await refusal({ filter: { filters: [{ Column: 'Amount', Operator: 'gt', Value: 50 }] } }, projection);
      expect(top).to.be.instanceOf(InvalidArgument);
      expect(top.message).to.contain('Amount');

      const nested = await refusal({ filter: { filters: [{ op: FilterableLogicalOperators.Or, filters: [{ Column: 'Note', Operator: 'like', Value: 'urgent' }] }] } }, projection);
      expect(nested).to.be.instanceOf(InvalidArgument);
      expect(nested.message).to.contain('Note');
    });

    it('refuses a sort by a column outside the list', async () => {
      const error = await refusal({ sorting: { by: [{ column: 'Amount' }] } }, projection);
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error.message).to.contain('Amount');
    });

    it('refuses a group column outside the list', async () => {
      const error = await refusal({ aggregate: { groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }] } }, { columns: ['Amount'] });
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error.message).to.contain('Status');
    });

    it('refuses a measure over a column outside the list, count included', async () => {
      const sum = await refusal({ aggregate: { measures: [{ name: 'total', fn: 'sum', column: 'Amount' }] } }, projection);
      expect(sum).to.be.instanceOf(InvalidArgument);
      expect(sum.message).to.contain('Amount');

      const count = await refusal({ aggregate: { measures: [{ name: 'n', fn: 'count', column: 'Amount' }] } }, projection);
      expect(count).to.be.instanceOf(InvalidArgument);
      expect(count.message).to.contain('Amount');
    });

    it('refuses an aggregate order by a column outside the list', async () => {
      const error = await refusal({ aggregate: { groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }], order: [{ column: 'Amount' }] } }, projection);
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error.message).to.contain('Amount');
    });

    it('still counts rows without a column', async () => {
      const answer = await readList(
        Order,
        { pagination: { limit: 0 }, aggregate: { groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }], order: [{ column: 'Status' }] } },
        projection,
      );
      expect(answer.rows).to.deep.equal([]);
      expect(answer.total).to.equal(5);
      expect(answer.aggregates).to.deep.equal([
        { Status: 'open', n: 3 },
        { Status: 'paid', n: 2 },
      ]);
    });

    it('refuses include together with columns', async () => {
      const error = await refusal({ include: ['Customer'] }, projection);
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error.fieldName).to.equal('include');
    });

    it('refuses a column the table does not have, as a mistake in the handler', async () => {
      expect(await refusal({}, { columns: ['Secret'] })).to.be.instanceOf(InvalidOption);
    });
  });

  describe('signal', () => {
    it('rejects with CanceledException carrying the reason when the signal is already aborted', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      controller.abort(reason);

      const error = await refusal({}, { signal: controller.signal });
      expect(error).to.be.instanceOf(CanceledException);
      expect(error.cause).to.equal(reason);
    });

    it('starts no statement after the signal aborts', async () => {
      const controller = new AbortController();
      const prototype = SelectQueryBuilder.prototype as unknown as { selectCount: (...args: unknown[]) => Promise<number> };
      const selectCount = prototype.selectCount;
      // Aborts while the count is in flight: the page is the next statement, and no aggregate is asked,
      // so only the check before the page can reject.
      prototype.selectCount = async function (this: unknown, ...args: unknown[]) {
        const count = await selectCount.apply(this, args);
        controller.abort();
        return count;
      };

      try {
        expect(await refusal({}, { signal: controller.signal })).to.be.instanceOf(CanceledException);
      } finally {
        prototype.selectCount = selectCount;
      }
    });

    it('answers as usual with a signal that never aborts', async () => {
      const answer = await readList(Order, {}, { signal: new AbortController().signal });
      expect(answer.total).to.equal(5);
    });
  });
});

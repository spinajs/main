import { expect } from 'chai';
import 'mocha';
import { SortOrder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';

import { DEFAULT_PAGE, MAX_PAGE_LIMIT, readPage, readSort } from '../src/paging.js';
import { OrderDTO, PaginationDTO } from '../src/dto.js';

class Rejected extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}
const reject = (field: string, message: string): never => {
  throw new Rejected(field, message);
};

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidArgument) return e.fieldName;
    throw e;
  }
  throw new Error('expected InvalidArgument');
}

describe('readPage', () => {
  it('returns DEFAULT_PAGE for absent input', () => {
    expect(readPage(undefined)).to.deep.equal(DEFAULT_PAGE);
    expect(readPage(null)).to.deep.equal(DEFAULT_PAGE);
    expect(readPage({})).to.deep.equal(DEFAULT_PAGE);
  });

  it('DEFAULT_PAGE is frozen', () => {
    expect(Object.isFrozen(DEFAULT_PAGE)).to.equal(true);
  });

  it('reads limit and offset', () => {
    expect(readPage({ limit: 20, offset: 40 })).to.deep.equal({ limit: 20, offset: 40 });
  });

  it('reads digit strings from a query string', () => {
    expect(readPage({ limit: '20', offset: '40' })).to.deep.equal({ limit: 20, offset: 40 });
  });

  it('turns a zero-based page index into an offset', () => {
    expect(readPage(new PaginationDTO({ limit: 25, page: 2 }))).to.deep.equal({ limit: 25, offset: 50 });
    expect(readPage({ page: 1 }, { defaultLimit: 10 })).to.deep.equal({ limit: 10, offset: 10 });
  });

  it('applies the default limit when none is given', () => {
    expect(readPage({ offset: 5 }, { defaultLimit: 10 })).to.deep.equal({ limit: 10, offset: 5 });
  });

  it('clamps limit to the max', () => {
    expect(readPage({ limit: 10_000 })).to.deep.equal({ limit: MAX_PAGE_LIMIT, offset: 0 });
    expect(readPage({ limit: 101 }, { maxLimit: 100 })).to.deep.equal({ limit: 100, offset: 0 });
  });

  it('computes the offset of a page index from the clamped limit', () => {
    expect(readPage({ limit: 1000, page: 2 }, { maxLimit: 100 })).to.deep.equal({ limit: 100, offset: 200 });
  });

  it('clamps the default limit to the max', () => {
    expect(readPage(undefined, { maxLimit: 20 })).to.deep.equal({ limit: 20, offset: 0 });
  });

  it('rejects limit 0, negative, fractional and non-numeric values with the field name', () => {
    expect(fieldOf(() => readPage({ limit: 0 }))).to.equal('limit');
    expect(fieldOf(() => readPage({ limit: '0' }))).to.equal('limit');
    expect(fieldOf(() => readPage({ limit: 1.5 }))).to.equal('limit');
    expect(fieldOf(() => readPage({ limit: NaN }))).to.equal('limit');
    expect(fieldOf(() => readPage({ limit: '-1' }))).to.equal('limit');
    expect(fieldOf(() => readPage({ offset: -1 }))).to.equal('offset');
    expect(fieldOf(() => readPage({ offset: '1e3' }))).to.equal('offset');
    expect(fieldOf(() => readPage({ offset: ['1', '2'] }))).to.equal('offset');
    expect(fieldOf(() => readPage({ page: -1 }))).to.equal('page');
  });

  it('rejects offset together with page', () => {
    expect(fieldOf(() => readPage({ offset: 10, page: 1 }))).to.equal('offset');
  });

  it('rejects input that is not an object', () => {
    expect(fieldOf(() => readPage(5))).to.equal('page');
    expect(fieldOf(() => readPage('limit=5'))).to.equal('page');
    expect(fieldOf(() => readPage([1, 2]))).to.equal('page');
  });

  it('routes failures through a custom invalid hook', () => {
    expect(() => readPage({ limit: -1 }, { invalid: reject })).to.throw(Rejected).with.property('field', 'limit');
  });
});

describe('readSort', () => {
  const SORTABLE = ['Id', 'Login', 'CreatedAt'];

  it('returns the fallback for absent input', () => {
    expect(readSort(undefined, SORTABLE, { column: 'CreatedAt', order: SortOrder.DESC })).to.deep.equal({ column: 'CreatedAt', order: SortOrder.DESC });
    expect(readSort({}, SORTABLE, { column: 'Id' })).to.deep.equal({ column: 'Id', order: SortOrder.ASC });
  });

  it('accepts a whitelisted column and normalises the order', () => {
    expect(readSort(new OrderDTO({ column: 'Login', order: 'desc' as SortOrder }), SORTABLE, { column: 'Id' })).to.deep.equal({ column: 'Login', order: SortOrder.DESC });
    expect(readSort({ column: 'Id', order: 'ASC' }, SORTABLE, { column: 'Id', order: SortOrder.DESC })).to.deep.equal({ column: 'Id', order: SortOrder.ASC });
  });

  it('keeps the fallback order when only a column is given', () => {
    expect(readSort({ column: 'Login' }, SORTABLE, { column: 'Id', order: SortOrder.DESC })).to.deep.equal({ column: 'Login', order: SortOrder.DESC });
  });

  it('rejects a column outside the whitelist', () => {
    expect(fieldOf(() => readSort({ column: 'Password' }, SORTABLE, { column: 'Id' }))).to.equal('column');
    expect(fieldOf(() => readSort({ column: 'login' }, SORTABLE, { column: 'Id' }))).to.equal('column');
    expect(fieldOf(() => readSort({ column: ['Id'] }, SORTABLE, { column: 'Id' }))).to.equal('column');
  });

  it('rejects an order that is not ASC or DESC', () => {
    expect(fieldOf(() => readSort({ order: 'up' }, SORTABLE, { column: 'Id' }))).to.equal('order');
  });

  it('lists the sortable columns in the message', () => {
    expect(() => readSort({ column: 'X' }, SORTABLE, { column: 'Id' })).to.throw(InvalidArgument, 'Sortable columns are: Id, Login, CreatedAt');
  });

  it('routes failures through a custom invalid hook', () => {
    expect(() => readSort({ column: 'X' }, SORTABLE, { column: 'Id' }, { invalid: reject })).to.throw(Rejected).with.property('field', 'column');
  });
});

import 'mocha';
import { expect } from 'chai';
import { SortOrder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { SCHEMA_SYMBOL } from '@spinajs/validation';
import { OrderDTO, SortingDTO } from '../src/dto.js';
import { MAX_SORT_COLUMNS, readSorting } from '../src/paging.js';
import { compileSchema } from './list-fixture.js';

const SORTABLE = ['Id', 'Status', 'Amount'];
const FALLBACK = { column: 'Id', order: SortOrder.ASC };

describe('readSorting', () => {
  it('answers the fallback alone when nothing is asked', () => {
    expect(readSorting(undefined, SORTABLE, FALLBACK)).to.deep.equal([{ column: 'Id', order: SortOrder.ASC }]);
    expect(readSorting({ by: [] }, SORTABLE, FALLBACK)).to.deep.equal([{ column: 'Id', order: SortOrder.ASC }]);
  });

  it('keeps the requested order of columns and ends with the fallback', () => {
    const sorts = readSorting({ by: [{ column: 'Status', order: 'desc' }, { column: 'Amount' }] }, SORTABLE, FALLBACK);
    expect(sorts).to.deep.equal([
      { column: 'Status', order: SortOrder.DESC },
      { column: 'Amount', order: SortOrder.ASC },
      { column: 'Id', order: SortOrder.ASC },
    ]);
  });

  it('does not repeat the fallback when it was asked for', () => {
    expect(readSorting({ by: [{ column: 'Id', order: 'DESC' }] }, SORTABLE, FALLBACK)).to.deep.equal([{ column: 'Id', order: SortOrder.DESC }]);
  });

  it('keeps the first of a column asked twice', () => {
    const sorts = readSorting({ by: [{ column: 'Amount', order: 'DESC' }, { column: 'Amount', order: 'ASC' }] }, SORTABLE, FALLBACK);
    expect(sorts.map((s) => `${s.column} ${s.order}`)).to.deep.equal([`Amount ${SortOrder.DESC}`, `Id ${SortOrder.ASC}`]);
  });

  it('refuses a column outside the sortable list', () => {
    expect(() => readSorting({ by: [{ column: 'Secret' }] }, SORTABLE, FALLBACK)).to.throw(InvalidArgument);
  });

  it('refuses a by that is no list, and a list over the cap', () => {
    expect(() => readSorting({ by: 'Status' }, SORTABLE, FALLBACK)).to.throw(InvalidArgument);
    const many = Array.from({ length: MAX_SORT_COLUMNS + 1 }, () => ({ column: 'Status' }));
    expect(() => readSorting({ by: many }, SORTABLE, FALLBACK)).to.throw(InvalidArgument);
  });
});

describe('SortingDTO', () => {
  const validate = compileSchema(Reflect.getMetadata(SCHEMA_SYMBOL, SortingDTO.prototype) ?? Reflect.getMetadata(SCHEMA_SYMBOL, SortingDTO));

  it('accepts a list of column and order entries', () => {
    expect(validate({ by: [{ column: 'Status', order: 'DESC' }, { column: 'Amount' }] })).to.equal(true);
  });

  it('refuses an entry without a column, an unknown order and an unknown member', () => {
    expect(validate({ by: [{ order: 'ASC' }] })).to.equal(false);
    expect(validate({ by: [{ column: 'Status', order: 'up' }] })).to.equal(false);
    expect(validate({ by: [], extra: 1 })).to.equal(false);
  });

  it('builds entries as OrderDTO and survives an absent value', () => {
    expect(new SortingDTO(undefined).by).to.deep.equal([]);
    const entry = new SortingDTO({ by: [{ column: 'Status' }] }).by[0];
    expect(entry).to.be.instanceOf(OrderDTO);
    expect(entry).to.have.property('column', 'Status');
  });
});

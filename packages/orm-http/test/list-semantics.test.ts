import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import { SCHEMA_SYMBOL } from '@spinajs/validation';
import { PaginationDTO } from '../src/dto.js';
import { FilterableLogicalOperators, FilterableOperators, IFilterEntry } from '../src/interfaces.js';
import { readList } from '../src/list.js';
import { MAX_PAGE_LIMIT, readPage } from '../src/paging.js';
import { bootListFixture, compileSchema, idsOf, Memo } from './list-fixture.js';

async function ids(filters: IFilterEntry[], op?: FilterableLogicalOperators): Promise<number[]> {
  return idsOf(await Memo.query().filter(filters, op));
}

const text = (Operator: FilterableOperators, Value?: unknown): IFilterEntry => ({ Column: 'Text', Operator, Value });

describe('list semantics a client relies on', function () {
  this.timeout(15000);

  before(bootListFixture);
  after(() => DI.clearCache());

  describe('the like family takes its value as literal text', () => {
    it('a percent sign or an underscore matches only itself', async () => {
      expect(await ids([text('like', '%')])).to.deep.equal([1]);
      expect(await ids([text('like', '_')])).to.deep.equal([2]);
    });

    it('starts with and ends with take the value literally too', async () => {
      expect(await ids([text('e-like', '100%')])).to.deep.equal([1]);
      expect(await ids([text('b-like', '_case')])).to.deep.equal([2]);
    });

    it('the negated family leaves out only the rows holding the literal text', async () => {
      expect(await ids([text('nlike', '%')])).to.deep.equal([2, 4, 5, 6]);
      expect(await ids([text('ne-like', '100%')])).to.deep.equal([2, 4, 5, 6]);
      expect(await ids([text('nb-like', '_case')])).to.deep.equal([1, 4, 5, 6]);
    });
  });

  describe('a null column', () => {
    it('matches none of neq, nin and the like family', async () => {
      for (const filter of [text('neq', 'zzz'), text('nin', ['zzz']), text('nlike', 'zzz'), text('nb-like', 'zzz'), text('ne-like', 'zzz')]) {
        expect(await ids([filter]), (filter as { Operator: string }).Operator).to.deep.equal([1, 2, 4, 5, 6]);
      }
      expect(await ids([text('like', 'a')])).to.deep.equal([2, 6]);
    });

    it('is included through an or group with isnull', async () => {
      const notZzzOrNull: IFilterEntry = { op: FilterableLogicalOperators.Or, filters: [text('nlike', 'zzz'), text('isnull')] };
      expect(await ids([notZzzOrNull])).to.deep.equal([1, 2, 3, 4, 5, 6]);

      const notPlainOrNull: IFilterEntry = { op: FilterableLogicalOperators.Or, filters: [text('neq', 'plain'), text('isnull')] };
      expect(await ids([notPlainOrNull])).to.deep.equal([1, 2, 3, 4, 5]);
    });
  });

  describe('empty', () => {
    it('is null or the empty string; text of spaces alone is not empty', async () => {
      expect(await ids([text('empty')])).to.deep.equal([3, 4]);
      expect(await ids([text('nempty')])).to.deep.equal([1, 2, 5, 6]);
    });
  });

  describe('aggregates', () => {
    it('count with a column counts the rows where it is not null; an empty string counts', async () => {
      const answer = await readList(Memo, {
        pagination: { limit: 0 },
        aggregate: {
          measures: [
            { name: 'texts', fn: 'count', column: 'Text' },
            { name: 'rows', fn: 'count' },
          ],
        },
      });
      expect(answer.aggregates).to.deep.equal([{ texts: 5, rows: 6 }]);
    });

    it('groupBy keeps null and the empty string as two groups', async () => {
      const answer = await readList(Memo, { pagination: { limit: 0 }, aggregate: { groupBy: ['Kind'], measures: [{ name: 'n', fn: 'count' }] } });
      expect(answer.aggregates).to.have.length(3);
      expect(answer.aggregates).to.have.deep.members([
        { Kind: 'a', n: 3 },
        { Kind: null, n: 1 },
        { Kind: '', n: 2 },
      ]);
    });
  });

  describe('page size', () => {
    it('readPage clamps a page to MAX_PAGE_LIMIT unless maxLimit is given', () => {
      expect(MAX_PAGE_LIMIT).to.equal(500);
      expect(readPage({ limit: 1000 })).to.deep.equal({ limit: 500, offset: 0 });
      expect(readPage({ limit: 1000, page: 2 }, { maxLimit: 1000 })).to.deep.equal({ limit: 1000, offset: 2000 });
      expect(readPage(undefined, { defaultLimit: 1000 })).to.deep.equal({ limit: 500, offset: 0 });
    });

    it('PaginationDTO does not cap limit; the clamp is readPage', () => {
      const validate = compileSchema(Reflect.getMetadata(SCHEMA_SYMBOL, PaginationDTO.prototype) ?? Reflect.getMetadata(SCHEMA_SYMBOL, PaginationDTO));
      expect(validate({ limit: 1000 })).to.equal(true);
    });

    it('readList passes options.maxLimit to readPage', async () => {
      const prototype = SelectQueryBuilder.prototype as unknown as { take: (count: number) => unknown };
      const take = prototype.take;
      const limits: number[] = [];
      prototype.take = function (this: unknown, count: number) {
        limits.push(count);
        return take.call(this, count);
      };

      try {
        await readList(Memo, { pagination: { limit: 1000 } });
        await readList(Memo, { pagination: { limit: 1000 } }, { maxLimit: 1000 });
      } finally {
        prototype.take = take;
      }

      // The count reads one row through takeFirst(); only the page sizes matter here.
      expect(limits.filter((limit) => limit > 1)).to.deep.equal([MAX_PAGE_LIMIT, 1000]);
    });
  });
});

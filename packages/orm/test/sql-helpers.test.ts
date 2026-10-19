import * as chai from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';

import { OrmDriver } from '../src/driver.js';
import { everyNthCall, insertChunked, isSqlFragment, rowsAffected, sql } from '../src/sql-helpers.js';

const expect = chai.expect;

const recordingDriver = (limits: { MaxBindings?: number; MaxInsertRows?: number }) => {
  const statements: object[][] = [];
  const driver = {
    MaxBindings: Number.POSITIVE_INFINITY,
    MaxInsertRows: Number.POSITIVE_INFINITY,
    ...limits,
    insert: () => ({
      into: () => ({
        values: (rows: object[]) => {
          statements.push(rows);
          return Promise.resolve({ RowsAffected: rows.length });
        },
      }),
    }),
  };
  return { driver: driver as unknown as OrmDriver, statements };
};

describe('sql helpers', () => {
  describe('rowsAffected', () => {
    it('reads RowsAffected', () => {
      expect(rowsAffected({ RowsAffected: 3, LastInsertId: 0 })).to.equal(3);
      expect(rowsAffected({ RowsAffected: 0 })).to.equal(0);
    });

    it('reads an unknown count as 0, never as success', () => {
      for (const r of [undefined, null, [], {}, { RowsAffected: '1' }, { RowsAffected: NaN }]) {
        expect(rowsAffected(r)).to.equal(0);
      }
    });
  });

  describe('insertChunked', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ a: i, b: i, c: i }));

    it('splits rows by the driver binding limit', async () => {
      const { driver, statements } = recordingDriver({ MaxBindings: 9 });
      expect(await insertChunked(driver, 't', rows)).to.equal(10);
      expect(statements.map((s) => s.length)).to.deep.equal([3, 3, 3, 1]);
    });

    it('splits rows by the driver row limit', async () => {
      const { driver, statements } = recordingDriver({ MaxInsertRows: 4 });
      await insertChunked(driver, 't', rows);
      expect(statements.map((s) => s.length)).to.deep.equal([4, 4, 2]);
    });

    it('sends one statement when the driver sets no limit', async () => {
      const { driver, statements } = recordingDriver({});
      await insertChunked(driver, 't', rows);
      expect(statements.map((s) => s.length)).to.deep.equal([10]);
    });
  });

  describe('sql fragments', () => {
    it('binds values, expands arrays and inlines fragments', () => {
      const inner = sql`b = ${2}`;
      const f = sql`a IN (${[1, 'x']}) AND ${inner} AND ${sql.raw('t.c')} > ${null}`;
      expect(f).to.deep.equal({ sql: 'a IN (?, ?) AND b = ? AND t.c > ?', bindings: [1, 'x', 2, null] });
    });

    it('refuses an empty list', () => {
      expect(() => sql`a IN (${[]})`).to.throw(InvalidArgument);
    });

    it('joins, ANDs and ORs', () => {
      const a = sql`a = ${1}`;
      const b = sql`b = ${2} OR c = ${3}`;
      expect(sql.join([a, b], ', ')).to.deep.equal({ sql: 'a = ?, b = ? OR c = ?', bindings: [1, 2, 3] });
      expect(sql.and([a, b])).to.deep.equal({ sql: '(a = ?) AND (b = ? OR c = ?)', bindings: [1, 2, 3] });
      expect(sql.or([a, b]).sql).to.equal('(a = ?) OR (b = ? OR c = ?)');
      expect(sql.or([a])).to.equal(a);
      expect(sql.or([])).to.equal(sql.FALSE);
      expect(sql.and([])).to.equal(sql.TRUE);
      expect(sql.FALSE.sql).to.equal('1 = 0');
    });

    it('tells a fragment apart', () => {
      expect(isSqlFragment(sql`x`)).to.equal(true);
      for (const v of [null, 'x', [], { sql: 'x' }, { sql: 1, bindings: [] }, new Date()]) {
        expect(isSqlFragment(v)).to.equal(false);
      }
    });
  });

  describe('everyNthCall', () => {
    it('is true on every n-th call', () => {
      const tick = everyNthCall(3);
      expect(Array.from({ length: 7 }, () => tick())).to.deep.equal([false, false, true, false, false, true, false]);
    });

    it('refuses a non-positive n', () => {
      expect(() => everyNthCall(0)).to.throw(InvalidArgument);
    });
  });
});

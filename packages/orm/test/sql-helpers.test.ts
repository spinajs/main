import * as chai from 'chai';
import 'mocha';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';

import { OrmDriver } from '../src/driver.js';
import { driverDialect, everyNthCall, isSqlFragment, isUniqueViolation, rowsAffected, sql } from '../src/sql-helpers.js';

const expect = chai.expect;

const fakeDriver = (className: string, registeredAs?: string): OrmDriver => {
  const cls = { [className]: class {} }[className];
  return Object.assign(new cls(), { Options: { Driver: registeredAs } }) as unknown as OrmDriver;
};

describe('sql helpers', () => {
  describe('driverDialect', () => {
    it('reads the dialect from the class chain', () => {
      class SqliteOrmDriver {}
      class Custom extends SqliteOrmDriver {}
      expect(driverDialect(new Custom() as unknown as OrmDriver)).to.equal('sqlite');
      expect(driverDialect(fakeDriver('MsSqlOrmDriver'))).to.equal('mssql');
    });

    it('falls back to the registered driver name', () => {
      expect(driverDialect(fakeDriver('X', 'orm-driver-postgres'))).to.equal('postgres');
      expect(driverDialect(fakeDriver('X', 'orm-driver-mysql-ssh'))).to.equal('mysql');
      expect(driverDialect(fakeDriver('X', 'orm-driver-oracle'))).to.equal('other');
    });
  });

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

  describe('isUniqueViolation', () => {
    it('recognises each dialect', () => {
      expect(isUniqueViolation({ code: '23505' })).to.equal(true);
      expect(isUniqueViolation({ code: 'ER_DUP_ENTRY', errno: 1062 })).to.equal(true);
      expect(isUniqueViolation({ errno: 1062 })).to.equal(true);
      expect(isUniqueViolation({ number: 2627 })).to.equal(true);
      expect(isUniqueViolation({ number: 2601 })).to.equal(true);
      expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.k'))).to.equal(true);
    });

    it('walks inner, cause and originalError', () => {
      expect(isUniqueViolation({ inner: { cause: { originalError: { number: 2627 } } } })).to.equal(true);
      expect(isUniqueViolation(new Error('wrapped', { cause: { code: '23505' } }))).to.equal(true);
    });

    it('does not take every sqlite constraint failure for a duplicate', () => {
      expect(isUniqueViolation(new ResourceDuplicated(String(new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed: t.k'))))).to.equal(false);
      expect(isUniqueViolation(new ResourceDuplicated(String(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.k'))))).to.equal(true);
    });

    it('is false for other errors and non-errors', () => {
      for (const e of [undefined, null, 'UNIQUE', 42, { code: '23503' }, { number: 547 }, new Error('boom')]) {
        expect(isUniqueViolation(e)).to.equal(false);
      }
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

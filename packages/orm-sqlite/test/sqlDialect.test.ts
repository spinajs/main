import { DI } from '@spinajs/di';
import { executeSql, familiesOf, reportsNullability, sql, sqlDialectOf } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { SQLITE_SQL_DIALECT, SqliteOrmDriver } from '../src/index.js';
import { bootUow, registerUowConnection } from './uowFixture.js';

const expect = chai.expect;
const jsType = (v: unknown): string => (v instanceof Date ? 'Date' : typeof v);

describe('sqlite SQL dialect profile', function () {
  this.timeout(10000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('is declared on the driver class', () => {
    expect(sqlDialectOf(SqliteOrmDriver)).to.equal(SQLITE_SQL_DIALECT);
  });

  it('raw SQL returns the types the profile declares', async () => {
    const [row] = await executeSql(sql<Record<string, unknown>>`SELECT COUNT(*) AS n, SUM(1) AS si, AVG(1) AS ai, SUM(1.5) AS sf, 1 = 1 AS p, CAST(1.5 AS DECIMAL) AS d`, { connection: 'sqlite' });
    const p = SQLITE_SQL_DIALECT;
    expect(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsType(v)]))).to.deep.equal({ n: p.count, si: p.sum.integer, ai: p.avg.integer, sf: p.sum.float, p: p.predicates, d: p.families.decimal });
  });

  it('maps the native types tableInfo() reports to column families, and distrusts boolean nullability', () => {
    expect(familiesOf('INTEGER', SQLITE_SQL_DIALECT)).to.deep.equal(['integer', 'bigint']);
    expect(familiesOf('', SQLITE_SQL_DIALECT)).to.deep.equal(['json']);
    expect(reportsNullability(SQLITE_SQL_DIALECT, 'boolean')).to.equal(false);
    expect(reportsNullability(SQLITE_SQL_DIALECT, 'text')).to.equal(true);
  });

  it('declares how migrate-diff compares names and text lengths', () => {
    expect(SQLITE_SQL_DIALECT.caseInsensitiveIdentifiers).to.equal(true);
    expect(SQLITE_SQL_DIALECT.unboundedText).to.equal(true);
    expect(SQLITE_SQL_DIALECT.alterColumnRebuildsTable).to.equal(true);
  });
});

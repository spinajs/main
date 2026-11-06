import 'mocha';
import { expect } from 'chai';
import { executeSql, sql } from '@spinajs/orm';
import { POSTGRES_SQL_DIALECT } from '../../src/index.js';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const jsType = (v: unknown): string => (v instanceof Date ? 'Date' : typeof v);

describe('postgres SQL dialect profile (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('sql_dialect');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('raw SQL returns the types the profile declares', async () => {
    const [row] = await executeSql(
      sql<Record<string, unknown>>`SELECT COUNT(*) AS n, SUM(1) AS si, AVG(1) AS ai, SUM(1.5::float8) AS sf, 1 = 1 AS p, 1::bigint AS b, 1.5::numeric AS d, now() AS dt, current_date AS da, '12:00'::time AS tm`,
      { connection: 'pg' },
    );
    const p = POSTGRES_SQL_DIALECT;
    expect(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsType(v)]))).to.deep.equal({
      n: p.count, si: p.sum.integer, ai: p.avg.integer, sf: p.sum.float, p: p.predicates, b: p.families.bigint, d: p.families.decimal, dt: p.families.datetime, da: p.families.date, tm: p.families.time,
    });
  });
});

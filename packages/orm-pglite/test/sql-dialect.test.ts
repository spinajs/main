import 'mocha';
import * as chai from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { executeSql, familiesOf, Orm, sql, sqlDialectOf } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';

import { PGLITE_SQL_DIALECT, PgliteOrmDriver } from '../src/index.js';
import { POSTGRES_SQL_DIALECT, toDriverStatement } from '@spinajs/orm-postgres';

const expect = chai.expect;

const CONNECTION = 'pglite-dialect';
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
const jsType = (v: unknown): string => (v instanceof Date ? 'Date' : typeof v);

function configuration(): Class<Configuration> {
  return class PgliteDialectConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
    }
  };
}

describe('pglite SQL dialect profile', function () {
  this.timeout(60000);

  it('is declared on the driver class under its own name', () => {
    expect(sqlDialectOf(PgliteOrmDriver)).to.equal(PGLITE_SQL_DIALECT);
    expect(PGLITE_SQL_DIALECT.name).to.equal('pglite');
    expect(PGLITE_SQL_DIALECT.grammar).to.equal('PostgresQL');
  });

  it('sends ? as $n', () => {
    expect(PGLITE_SQL_DIALECT.placeholders).to.equal('dollar');
    expect(toDriverStatement('SELECT a FROM t WHERE a = ?', [1])).to.equal('SELECT a FROM t WHERE a = $1');
  });

  it('raw SQL returns the types the profile declares', async () => {
    const app = await createTestApp({ configuration: configuration(), register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    try {
      await app.resolve(Orm);
      const [row] = await executeSql(
        sql<Record<string, unknown>>`SELECT COUNT(*) AS n, SUM(1) AS si, AVG(1) AS ai, SUM(1.5::float8) AS sf, 1 = 1 AS p, 1::bigint AS b, 1.5::numeric AS d, now() AS dt, current_date AS da, '12:00'::time AS tm, '{"a":1}'::json AS j`,
        { connection: CONNECTION },
      );
      const p = PGLITE_SQL_DIALECT;
      const { j, ...rest } = row;
      expect(Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, jsType(v)]))).to.deep.equal({
        n: p.count, si: p.sum.integer, ai: p.avg.integer, sf: p.sum.float, p: p.predicates, b: p.families.bigint, d: p.families.decimal, dt: p.families.datetime, da: p.families.date, tm: p.families.time,
      });
      // json parses to an object whose shape no profile type names, hence 'unknown'.
      expect(jsType(j)).to.equal('object');
      expect(p.families.json).to.equal('unknown');
    } finally {
      await app.dispose();
    }
  });

  it('maps the pg catalog types tableInfo() reports to column families', () => {
    expect(familiesOf('int8', PGLITE_SQL_DIALECT)).to.deep.equal(['bigint']);
    expect(PGLITE_SQL_DIALECT.nativeTypes).to.deep.equal(POSTGRES_SQL_DIALECT.nativeTypes);
  });

  it('declares how migrate-diff compares names and text lengths', () => {
    expect(PGLITE_SQL_DIALECT.caseInsensitiveIdentifiers).to.equal(undefined);
    expect(PGLITE_SQL_DIALECT.unboundedText).to.equal(undefined);
  });
});

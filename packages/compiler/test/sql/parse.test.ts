import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest, SqlDialectEntry, SqlDialectProfile } from '@spinajs/manifest';
import { findSqlDialect, GENERIC_SQL_DIALECT, readSqlDialects, resolveSqlDialect } from '../../src/sql/dialects.js';
import { bindParameters, parseSql } from '../../src/sql/parse.js';
import { MSSQL, MYSQL, PG, SQLITE } from './profiles.js';

describe('bindParameters', () => {
  it('numbers ? as $1.. and @p0.., outside literals, quoted names and comments', () => {
    expect(bindParameters("SELECT '?' AS q, \"a?\" FROM t WHERE a = ? -- ?\nAND b = ?", 'dollar')).to.equal("SELECT '?' AS q, \"a?\" FROM t WHERE a = $1 -- ?\nAND b = $2");
    expect(bindParameters('SELECT [x?] FROM t WHERE a = ? /* ? */ AND b = ?', 'at-p0')).to.equal('SELECT [x?] FROM t WHERE a = @p0 /* ? */ AND b = @p1');
  });

  it('skips escape strings and dollar-quoted strings', () => {
    expect(bindParameters("SELECT E'a\\'?' AS e, $$ ? $$ AS d FROM t WHERE a = ?", 'dollar')).to.equal("SELECT E'a\\'?' AS e, $$ ? $$ AS d FROM t WHERE a = $1");
  });

  it('keeps the jsonb ?| and ?& operators, as the postgres driver does', () => {
    expect(bindParameters('SELECT a FROM t WHERE b ?| ? AND c ?& ? AND d = ?||?', 'dollar')).to.equal('SELECT a FROM t WHERE b ?| $1 AND c ?& $2 AND d = $3||$4');
  });

  it('leaves question-mark text alone', () => {
    expect(bindParameters('SELECT ? FROM t', 'question')).to.equal('SELECT ? FROM t');
  });
});

describe('parseSql', () => {
  it('parses a parameterised select with every profile', () => {
    for (const profile of [PG, MYSQL, SQLITE, MSSQL, GENERIC_SQL_DIALECT]) expect(parseSql('SELECT Id FROM users WHERE Id = ?', profile).ok, profile.name).to.equal(true);
  });

  it('reports the line of a syntax error', () => {
    expect(parseSql('SELECT Id\nFROM users WHERE', SQLITE)).to.deep.equal({ ok: false, message: 'unexpected end of query on line 2 of the query' });
  });

  it('reports the VALUES row whose length differs from the column list when the grammar rejects it', () => {
    expect(parseSql('INSERT INTO t (a, b) VALUES (?, ?), (?)', MYSQL)).to.deep.equal({ ok: false, message: "column count doesn't match value count at row 2", valuesRow: 2 });
  });
});

const entry = (profile: SqlDialectProfile, drivers: string[]): SqlDialectEntry => ({ drivers, profile, source: { file: 'src/index.ts', line: 1, col: 1, package: 'driver' } });
const installed: Pick<Manifest, 'sqlDialects'> = { sqlDialects: [entry(PG, ['orm-driver-postgres']), entry(SQLITE, ['orm-driver-sqlite'])] };
const onlyPg: Pick<Manifest, 'sqlDialects'> = { sqlDialects: [entry(PG, ['orm-driver-postgres'])] };

describe('dialects', () => {
  it('finds a profile by name or by driver token', () => {
    expect([findSqlDialect(installed, 'postgresql'), findSqlDialect(installed, 'orm-driver-sqlite'), findSqlDialect(installed, 'oracle')]).to.deep.equal([PG, SQLITE, undefined]);
  });

  it('lets a later fragment override an earlier one, as the app overrides its packages', () => {
    const custom: SqlDialectProfile = { ...PG, count: 'number' };
    expect(findSqlDialect({ sqlDialects: [...installed.sqlDialects!, entry(custom, ['orm-driver-postgres'])] }, 'orm-driver-postgres')).to.equal(custom);
  });

  it('resolves the declared name, then the configured driver, then the only installed dialect', () => {
    expect(resolveSqlDialect(installed, 'sqlite', 'orm-driver-postgres')).to.equal(SQLITE);
    expect(resolveSqlDialect(installed, 'oracle')).to.equal(undefined);
    expect(resolveSqlDialect(installed, undefined, 'orm-driver-postgres')).to.equal(PG);
    expect(resolveSqlDialect(installed)).to.equal(undefined);
    expect(resolveSqlDialect(onlyPg)).to.equal(PG);
    expect(resolveSqlDialect(onlyPg, undefined, 'orm-driver-oracle')).to.equal(undefined);
    expect(resolveSqlDialect(onlyPg, 'oracle')).to.equal(undefined);
  });

  it('reads package.json#spinajs.orm.dialects, keeping names the manifest resolves later', () => {
    const root = mkdtempSync(join(tmpdir(), 'dialects-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ spinajs: { orm: { dialects: { default: 'postgresql', reports: 'oracle', bad: 3 } } } }));
    expect(readSqlDialects(root)).to.deep.equal({ default: 'postgresql', reports: 'oracle' });
    expect(readSqlDialects(join(root, 'missing'))).to.deep.equal({});
  });
});

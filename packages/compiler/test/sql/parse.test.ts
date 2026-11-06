import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dialectOfDriver, readSqlDialects, SQL_DIALECTS } from '../../src/sql/dialects.js';
import { bindParameters, parseSql } from '../../src/sql/parse.js';

describe('bindParameters', () => {
  it('numbers ? for postgresql and T-SQL, outside literals, quoted names and comments', () => {
    expect(bindParameters("SELECT '?' AS q, \"a?\" FROM t WHERE a = ? -- ?\nAND b = ?", 'postgresql')).to.equal("SELECT '?' AS q, \"a?\" FROM t WHERE a = $1 -- ?\nAND b = $2");
    expect(bindParameters('SELECT [x?] FROM t WHERE a = ? /* ? */ AND b = ?', 'transactsql')).to.equal('SELECT [x?] FROM t WHERE a = @p1 /* ? */ AND b = @p2');
  });

  it('skips escape strings and dollar-quoted strings', () => {
    expect(bindParameters("SELECT E'a\\'?' AS e, $$ ? $$ AS d FROM t WHERE a = ?", 'postgresql')).to.equal("SELECT E'a\\'?' AS e, $$ ? $$ AS d FROM t WHERE a = $1");
  });

  it('leaves mysql and sqlite text alone', () => {
    expect(bindParameters('SELECT ? FROM t', 'mysql')).to.equal('SELECT ? FROM t');
    expect(bindParameters('SELECT ? FROM t', 'sqlite')).to.equal('SELECT ? FROM t');
  });
});

describe('parseSql', () => {
  it('parses a parameterised select in every dialect', () => {
    for (const dialect of SQL_DIALECTS) expect(parseSql('SELECT Id FROM users WHERE Id = ?', dialect).ok, dialect).to.equal(true);
  });

  it('reports the line of a syntax error', () => {
    expect(parseSql('SELECT Id\nFROM users WHERE', 'sqlite')).to.deep.equal({ ok: false, message: 'unexpected end of query on line 2 of the query' });
  });

  // Prototype finding (A6), re-verified in Step 1b. If the mysql grammar accepts the statement, expect `ok: true` here; Task 11 then reports SQL006 from the AST.
  it('reports the VALUES row whose length differs from the column list when the grammar rejects it', () => {
    expect(parseSql('INSERT INTO t (a, b) VALUES (?, ?), (?)', 'mysql')).to.deep.equal({ ok: false, message: "column count doesn't match value count at row 2", valuesRow: 2 });
  });
});

describe('dialects', () => {
  it('maps the ORM driver tokens', () => {
    expect(['orm-driver-postgres', 'orm-driver-pglite', 'orm-driver-mysql', 'orm-driver-sqlite', 'orm-driver-mssql', 'orm-driver-x'].map(dialectOfDriver)).to.deep.equal(['postgresql', 'postgresql', 'mysql', 'sqlite', 'transactsql', undefined]);
  });

  it('reads package.json#spinajs.orm.dialects and drops unknown names', () => {
    const root = mkdtempSync(join(tmpdir(), 'dialects-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ spinajs: { orm: { dialects: { default: 'postgresql', reports: 'oracle' } } } }));
    expect(readSqlDialects(root)).to.deep.equal({ default: 'postgresql' });
    expect(readSqlDialects(join(root, 'missing'))).to.deep.equal({});
  });
});

import 'mocha';
import { expect } from 'chai';
import type { ModelEntry, ModelSqlQuery, SqlDialectEntry, SqlDialectProfile } from '@spinajs/manifest';
import { dialectFor, sqlAmbiguousColumn, sqlDynamic, sqlNoDialect, sqlParseError, sqlRowMismatch, sqlUnknownColumn, sqlUnknownTable } from '../../src/doctor/rules/sql-queries.js';
import { PG, SQLITE } from '../sql/profiles.js';
import { fixture, src } from './fixture.js';

const base = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const users: ModelEntry = {
  id: 'app:User', className: 'User', tableName: 'users', accessResource: false, relations: [], source: src('src/user.ts'),
  columns: [{ name: 'Id', type: { text: 'number' }, primary: true, nullable: false }, { name: 'Email', type: { text: 'string' }, primary: false, nullable: false }],
};
const dialect = (profile: SqlDialectProfile, drivers: string[]): SqlDialectEntry => ({ drivers, profile, source: src('src/index.ts') });
const sqlDialects = [dialect(PG, ['orm-driver-postgres']), dialect(SQLITE, ['orm-driver-sqlite'])];
const query = (text: string, line: number, extra: Partial<ModelSqlQuery> = {}): ModelSqlQuery => ({ id: `src/q.ts:${line}:1`, text, placeholders: 0, dynamic: false, source: src('src/q.ts', line), ...extra });

describe('SQL doctor rules', () => {
  const manifest = fixture({
    models: [users],
    sqlDialects,
    sqlQueries: [
      query('SELECT Id, Emial FROM users', 3),
      query('SELECT Id FROM usrs', 4),
      query('SELECT Id FROM users WHERE', 5),
      query('SELECT ? FROM users', 6, { dynamic: true }),
      query('Email = ?', 7, { dynamic: true }),
      query('SELECT Id FROM users', 8, { connection: 'reports' }),
      query('SELECT Id FROM users', 9, { connection: 'legacy' }),
      query('SELECT COUNT(*) AS n FROM users', 10, { declaredColumns: [{ name: 'n', ts: 'number', nullable: false }] }),
    ],
  });
  const ctx = { ...base, sqlDialects: { default: 'postgresql', legacy: 'oracle' } };

  it('each rule reports only its own code, at the template', () => {
    expect(sqlUnknownColumn.run(manifest, ctx)).to.deep.equal([{ code: 'SQL003', severity: 'warning', message: 'Column Emial is not declared on users', source: src('src/q.ts', 3) }]);
    expect(sqlUnknownTable.run(manifest, ctx)).to.deep.equal([{ code: 'SQL002', severity: 'error', message: 'Table usrs is not the table of any model', source: src('src/q.ts', 4) }]);
    expect(sqlParseError.run(manifest, ctx)).to.deep.equal([{ code: 'SQL001', severity: 'error', message: 'SQL does not parse as postgresql: unexpected end of query on line 1 of the query', source: src('src/q.ts', 5) }]);
    expect(sqlAmbiguousColumn.run(manifest, ctx)).to.deep.equal([]);
  });

  it('SQL010 lists a dynamic statement; a dynamic fragment is not reported', () => {
    expect(sqlDynamic.run(manifest, ctx)).to.deep.equal([{ code: 'SQL010', severity: 'info', message: 'Dynamic SQL is not checked: the template interpolates a SqlFragment or sql.raw', source: src('src/q.ts', 6) }]);
  });

  it('SQL011 once per connection without a dialect, and for a name no installed driver declares', () => {
    expect(sqlNoDialect.run(manifest, ctx)).to.deep.equal([
      { code: 'SQL011', severity: 'warning', message: "No SQL dialect for connection 'reports': set package.json#spinajs.orm.dialects.reports in the app; its queries are checked with the generic mysql grammar and driver-dependent columns are typed unknown", source: src('src/q.ts', 8) },
      { code: 'SQL011', severity: 'warning', message: "Connection 'legacy' names SQL dialect 'oracle', which no installed driver declares; its queries are checked with the generic mysql grammar and driver-dependent columns are typed unknown", source: src('src/q.ts', 9) },
    ]);
    expect(sqlNoDialect.run(fixture({ models: [users] }), base)).to.deep.equal([]);
  });

  it('SQL005 types COUNT the way the postgres driver returns it', () => {
    expect(sqlRowMismatch.run(manifest, ctx)).to.deep.equal([{ code: 'SQL005', severity: 'error', message: 'sql<…> row differs from the query: n is string, declared number', source: src('src/q.ts', 10) }]);
  });
});

describe('dialectFor', () => {
  const config = { db: { DefaultConnection: 'main', Connections: [{ Name: 'main', Driver: 'orm-driver-sqlite' }, { Name: 'pg', Driver: 'orm-driver-postgres' }], Aliases: { reports: 'pg' } } };
  const installed = fixture({ sqlDialects });

  it('prefers package.json', () => {
    expect(dialectFor('default', installed, { ...base, config, sqlDialects: { default: 'postgresql' } })).to.equal(PG);
  });

  it('falls back to the driver of the connection, through an alias or the default connection', () => {
    const ctx = { ...base, config };
    expect(['main', 'reports', 'default', 'other'].map((name) => dialectFor(name, installed, ctx)?.name)).to.deep.equal(['sqlite', 'postgresql', 'sqlite', undefined]);
  });

  it('takes the only installed dialect when nothing names one', () => {
    expect(dialectFor('other', fixture({ sqlDialects: [dialect(PG, ['orm-driver-postgres'])] }), base)).to.equal(PG);
  });
});

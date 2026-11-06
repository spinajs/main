import 'mocha';
import { expect } from 'chai';
import type { ModelEntry, ModelSqlQuery } from '@spinajs/manifest';
import { dialectFor, sqlAmbiguousColumn, sqlDynamic, sqlNoDialect, sqlParseError, sqlUnknownColumn, sqlUnknownTable } from '../../src/doctor/rules/sql-queries.js';
import { fixture, src } from './fixture.js';

const base = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const users: ModelEntry = {
  id: 'app:User', className: 'User', tableName: 'users', accessResource: false, relations: [], source: src('src/user.ts'),
  columns: [{ name: 'Id', type: { text: 'number' }, primary: true, nullable: false }, { name: 'Email', type: { text: 'string' }, primary: false, nullable: false }],
};
const query = (text: string, line: number, extra: Partial<ModelSqlQuery> = {}): ModelSqlQuery => ({ id: `src/q.ts:${line}:1`, text, placeholders: 0, dynamic: false, source: src('src/q.ts', line), ...extra });

describe('SQL doctor rules', () => {
  const manifest = fixture({
    models: [users],
    sqlQueries: [
      query('SELECT Id, Emial FROM users', 3),
      query('SELECT Id FROM usrs', 4),
      query('SELECT Id FROM users WHERE', 5),
      query('SELECT ? FROM users', 6, { dynamic: true }),
      query('Email = ?', 7, { dynamic: true }),
      query('SELECT Id FROM users', 8, { connection: 'reports' }),
    ],
  });
  const ctx = { ...base, sqlDialects: { default: 'postgresql' as const } };

  it('each rule reports only its own code, at the template', () => {
    expect(sqlUnknownColumn.run(manifest, ctx)).to.deep.equal([{ code: 'SQL003', severity: 'warning', message: 'Column Emial is not declared on users', source: src('src/q.ts', 3) }]);
    expect(sqlUnknownTable.run(manifest, ctx)).to.deep.equal([{ code: 'SQL002', severity: 'error', message: 'Table usrs is not the table of any model', source: src('src/q.ts', 4) }]);
    expect(sqlParseError.run(manifest, ctx)).to.deep.equal([{ code: 'SQL001', severity: 'error', message: 'SQL does not parse as postgresql: unexpected end of query on line 1 of the query', source: src('src/q.ts', 5) }]);
    expect(sqlAmbiguousColumn.run(manifest, ctx)).to.deep.equal([]);
  });

  it('SQL010 lists a dynamic statement; a dynamic fragment is not reported', () => {
    expect(sqlDynamic.run(manifest, ctx)).to.deep.equal([{ code: 'SQL010', severity: 'info', message: 'Dynamic SQL is not checked: the template interpolates a SqlFragment or sql.raw', source: src('src/q.ts', 6) }]);
  });

  it('SQL011 once per connection without a dialect', () => {
    expect(sqlNoDialect.run(manifest, ctx)).to.deep.equal([
      { code: 'SQL011', severity: 'warning', message: "No SQL dialect for connection 'reports': set package.json#spinajs.orm.dialects.reports in the app; its queries are checked with the generic mysql grammar", source: src('src/q.ts', 8) },
    ]);
    expect(sqlNoDialect.run(fixture({ models: [users] }), base)).to.deep.equal([]);
  });
});

describe('dialectFor', () => {
  const config = { db: { DefaultConnection: 'main', Connections: [{ Name: 'main', Driver: 'orm-driver-sqlite' }, { Name: 'pg', Driver: 'orm-driver-postgres' }], Aliases: { reports: 'pg' } } };

  it('prefers package.json', () => {
    expect(dialectFor('default', { ...base, config, sqlDialects: { default: 'mysql' } })).to.equal('mysql');
  });

  it('falls back to the driver of the connection, through an alias or the default connection', () => {
    const ctx = { ...base, config };
    expect(['main', 'reports', 'default', 'other'].map((name) => dialectFor(name, ctx))).to.deep.equal(['sqlite', 'postgresql', 'sqlite', undefined]);
  });
});

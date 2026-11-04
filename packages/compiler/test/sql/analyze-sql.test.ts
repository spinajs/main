import 'mocha';
import { expect } from 'chai';
import type { Manifest, ModelColumn, ModelEntry, ModelSqlQuery, SqlRowColumn } from '@spinajs/manifest';
import { analyzeSql, type SqlDialect } from '../../src/sql/index.js';

const source = { file: 'src/queries.ts', line: 7, col: 3, package: 'app' };
const col = (name: string, text: string, nullable = false): ModelColumn => ({ name, type: { text }, primary: name === 'Id', nullable });
const model = (className: string, tableName: string, columns: ModelColumn[], exhaustive = false, connection?: string): ModelEntry => ({
  id: `app:${className}`, className, tableName, columns, relations: [], accessResource: false, ...(exhaustive ? { exhaustive: true as const } : {}), ...(connection ? { connection } : {}), source,
});

const manifest = {
  models: [
    model('User', 'users', [col('Id', 'number'), col('Email', 'string'), col('Name', 'string', true), col('CreatedAt', 'DateTime'), col('Role', '"admin" | "user"')]),
    model('Post', 'posts', [col('Id', 'number'), col('user_id', 'number'), col('Title', 'string'), col('Body', 'string', true)]),
    model('Tag', 'tags', [col('Id', 'number'), col('Name', 'string')], true),
    // A second `users` table on another connection (A17): only `Id` is declared there.
    model('UserMirror', 'users', [col('Id', 'number')], false, 'reports'),
  ],
} as unknown as Manifest;

const query = (text: string, extra: Partial<ModelSqlQuery> = {}): ModelSqlQuery => ({ id: 'src/queries.ts:7:3', text, placeholders: 0, dynamic: false, source, ...extra });
const c = (name: string, ts: string, nullable = false): SqlRowColumn => ({ name, ts, nullable });

interface Case { name: string; text: string; dialect?: SqlDialect; extra?: Partial<ModelSqlQuery>; row?: SqlRowColumn[] | 'unknown'; problems?: string[] }

const USER_ROW = [c('Id', 'number'), c('Email', 'string'), c('Name', 'string', true), c('CreatedAt', 'unknown'), c('Role', '"admin" | "user"')];

const CASES: Case[] = [
  { name: 'plain and quoted columns', text: 'SELECT "Id", Email FROM users', row: [c('Id', 'number'), c('Email', 'string')] },
  { name: 'table alias and column alias', text: 'SELECT u.Id AS id, u.Name FROM users u', row: [c('id', 'number'), c('Name', 'string', true)] },
  { name: 'star over a partial model', text: 'SELECT * FROM users', row: USER_ROW },
  { name: 'qualified star', text: 'SELECT p.* FROM posts p JOIN users u ON u.Id = p.user_id', row: [c('Id', 'number'), c('user_id', 'number'), c('Title', 'string'), c('Body', 'string', true)] },
  { name: 'inner join', text: 'SELECT u.Email, p.Title FROM users u JOIN posts p ON p.user_id = u.Id', row: [c('Email', 'string'), c('Title', 'string')] },
  { name: 'LEFT JOIN makes the right side nullable', text: 'SELECT u.Email, p.Title FROM users u LEFT JOIN posts p ON p.user_id = u.Id', row: [c('Email', 'string'), c('Title', 'string', true)] },
  { name: 'RIGHT JOIN makes the left side nullable', text: 'SELECT u.Email, p.Title FROM users u RIGHT JOIN posts p ON p.user_id = u.Id', row: [c('Email', 'string', true), c('Title', 'string')] },
  { name: 'COUNT is a non-null number', text: 'SELECT COUNT(*) AS n FROM users', row: [c('n', 'number')] },
  { name: 'SUM is a nullable number', text: 'SELECT SUM(Id) AS total FROM posts', row: [c('total', 'number', true)] },
  { name: 'MAX keeps the argument type', text: 'SELECT MAX(Email) AS last FROM users', row: [c('last', 'string', true)] },
  { name: 'CASE with ELSE', text: "SELECT CASE WHEN Id > 1 THEN 'big' ELSE 'small' END AS size FROM users", row: [c('size', 'string')] },
  { name: 'CASE without ELSE is nullable', text: 'SELECT CASE WHEN Id > 1 THEN 1 END AS big FROM users', row: [c('big', 'number', true)] },
  { name: 'COALESCE is null only when every argument is', text: 'SELECT COALESCE(Name, Email) AS label FROM users', row: [c('label', 'string')] },
  { name: 'subquery in FROM', text: 'SELECT x.a FROM (SELECT Id AS a FROM users) x', row: [c('a', 'number')] },
  { name: 'CTE', text: 'WITH t AS (SELECT Id, Email FROM users) SELECT t.Email FROM t', row: [c('Email', 'string')] },
  { name: 'INSERT RETURNING', text: 'INSERT INTO users (Email, Name) VALUES (?, ?) RETURNING Id', row: [c('Id', 'number')] },
  { name: 'UPDATE RETURNING', text: 'UPDATE posts SET Title = ? WHERE Id = ? RETURNING Id, Title', row: [c('Id', 'number'), c('Title', 'string')] },
  { name: 'DELETE RETURNING', text: 'DELETE FROM posts WHERE Id = ? RETURNING user_id', row: [c('user_id', 'number')] },
  { name: 'INSERT without RETURNING returns no columns', text: 'INSERT INTO users (Email, Name) VALUES (?, ?), (?, ?)', row: [] },
  { name: 'SQL002 unknown table', text: 'SELECT Id FROM usrs', row: [c('Id', 'unknown', true)], problems: ['SQL002 error Table usrs is not the table of any model'] },
  { name: 'SQL003 on a partial model is a warning', text: 'SELECT Nmae FROM users', row: [c('Nmae', 'unknown', true)], problems: ['SQL003 warning Column Nmae is not declared on users'] },
  { name: 'SQL003 on an exhaustive model is an error', text: 'SELECT Label FROM tags', problems: ['SQL003 error Column Label is not declared on tags'] },
  { name: 'SQL003 unknown alias', text: 'SELECT x.Id FROM users u', problems: ['SQL003 error x.Id: x is not a table or alias of the query'] },
  { name: 'SQL003 in UPDATE SET', text: 'UPDATE tags SET Label = ? WHERE Id = ?', problems: ['SQL003 error Column Label is not declared on tags'] },
  { name: 'SQL004 ambiguous column', text: 'SELECT Id FROM users u JOIN posts p ON p.user_id = u.Id', row: [c('Id', 'unknown', true)], problems: ['SQL004 error Column Id is ambiguous: u, p have it'] },
  { name: 'SQL006 INSERT count', text: 'INSERT INTO users (Email, Name) VALUES (?, ?, ?)', problems: ['SQL006 error INSERT column list and VALUES row 1 differ in length'] },
  { name: 'SQL006 skipped for a list parameter', text: 'INSERT INTO users (Email, Name) VALUES (?)', extra: { lists: [0] }, problems: [] },
  { name: 'SQL001 parse error', text: 'SELECT Id FROM users WHERE', row: 'unknown', problems: ['SQL001 error SQL does not parse as postgresql: unexpected end of query on line 1 of the query'] },
  { name: 'SQL005 type', text: 'SELECT Id FROM users', extra: { declaredColumns: [c('Id', 'string')] }, problems: ['SQL005 error sql<…> row differs from the query: Id is number, declared string'] },
  { name: 'SQL005 nullability', text: 'SELECT Name FROM users', extra: { declaredColumns: [c('Name', 'string')] }, problems: ['SQL005 error sql<…> row differs from the query: Name can be null, declared string'] },
  { name: 'SQL005 names', text: 'SELECT Id, Email FROM users', extra: { declaredColumns: [c('Id', 'number'), c('Mail', 'string')] }, problems: ['SQL005 error sql<…> row differs from the query: Email is returned but not declared; Mail is declared but not returned'] },
  { name: 'a declared row that matches', text: 'SELECT Id, Name FROM users', extra: { declaredColumns: [c('Id', 'number'), c('Name', 'string', true)] }, problems: [] },
  { name: 'star over a partial model may return undeclared columns', text: 'SELECT u.* FROM users u', extra: { declaredColumns: [...USER_ROW, c('EmailVerifiedAt', 'string', true)] }, problems: [] },
  { name: 'a dynamic query is not checked', text: 'SELECT Nmae FROM usrs', extra: { dynamic: true }, row: 'unknown', problems: [] },
  { name: 'a fragment is not a statement', text: 'Nmae = ? AND Id > 1', row: 'unknown', problems: [] },
  { name: 'the ignore comment', text: 'SELECT Nmae FROM users -- spinajs-sql-ignore', row: 'unknown', problems: [] },
  { name: 'mysql backticks and ?', dialect: 'mysql', text: 'SELECT `Id`, Email FROM users WHERE Id = ?', row: [c('Id', 'number'), c('Email', 'string')] },
  { name: 'sqlite LIMIT', dialect: 'sqlite', text: 'SELECT Id FROM users WHERE Email = ? LIMIT 1', row: [c('Id', 'number')] },
  { name: 'transactsql TOP and brackets', dialect: 'transactsql', text: 'SELECT TOP 1 [Id] FROM [users] WHERE Email = ?', row: [c('Id', 'number')] },
  { name: 'correlated EXISTS subquery', text: 'SELECT Email FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.Id)', row: [c('Email', 'string')] },
  { name: 'IN subquery is checked', text: 'SELECT Email FROM users WHERE Id IN (SELECT author_id FROM posts)', problems: ['SQL003 warning Column author_id is not declared on posts'] },
  { name: 'an unnamed expression makes the row unknown', text: 'SELECT Id + 1 FROM users', row: 'unknown' },
  { name: 'ORDER BY an output alias', text: 'SELECT Email AS e FROM users ORDER BY e', problems: [] },
  { name: 'GROUP BY and HAVING', text: 'SELECT user_id, COUNT(*) AS n FROM posts GROUP BY user_id HAVING COUNT(*) > 1', row: [c('user_id', 'number'), c('n', 'number')] },
  { name: 'UNION takes the first row and checks both', text: 'SELECT Id FROM users UNION SELECT Nope FROM posts', row: [c('Id', 'number')], problems: ['SQL003 warning Column Nope is not declared on posts'] },
  { name: 'a ? inside a string literal is not a parameter', text: "SELECT Id FROM users WHERE Email LIKE '%?%' AND Id = ?", row: [c('Id', 'number')] },
  { name: 'a connection scopes the tables to its models (A17)', text: 'SELECT Email FROM users', extra: { connection: 'reports' }, problems: ['SQL003 warning Column Email is not declared on users'] },
  { name: 'a connection with no models falls back to every model', text: 'SELECT Email FROM users', extra: { connection: 'other' }, row: [c('Email', 'string')], problems: [] },
  { name: 'SQL003 on a column no CTE or subquery declares', text: 'WITH t AS (SELECT Id FROM users) SELECT Nope FROM t', problems: ['SQL003 warning Column Nope is not declared by any table, subquery or CTE of the query'] },
];

describe('analyzeSql', () => {
  for (const t of CASES) {
    it(t.name, () => {
      const analysis = analyzeSql(query(t.text, t.extra), manifest, t.dialect ?? 'postgresql');
      if (t.row !== undefined) expect(analysis.row).to.deep.equal(t.row);
      expect(analysis.problems.map((p) => `${p.code} ${p.severity} ${p.message}`)).to.deep.equal(t.problems ?? []);
      for (const p of analysis.problems) expect(p.source).to.deep.equal(source);
    });
  }

  it('lists the tables and columns a query reads', () => {
    const analysis = analyzeSql(query('SELECT u.Email, p.Title FROM users u JOIN posts p ON p.user_id = u.Id'), manifest, 'postgresql');
    expect(analysis.tables).to.deep.equal(['users', 'posts']);
    expect(analysis.columns).to.deep.equal([
      { table: 'posts', column: 'user_id' },
      { table: 'users', column: 'Id' },
      { table: 'users', column: 'Email' },
      { table: 'posts', column: 'Title' },
    ]);
  });
});

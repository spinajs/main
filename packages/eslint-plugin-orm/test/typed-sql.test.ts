import { RuleTester } from '@typescript-eslint/rule-tester';
import { fileURLToPath } from 'node:url';
import { typedSql } from '../src/rules/typed-sql.js';

// RuleTester finds mocha's describe/it as globals; only the teardown hook has another name.
RuleTester.afterAll = after;

const app = fileURLToPath(new URL('./fixtures/app', import.meta.url));
const filename = `${app}/src/queries.ts`;
const ruleTester = new RuleTester();
const head = "import { sql } from '@spinajs/orm';\n";
// Puts the query on the line the fixture manifest records for it.
const at = (line: number, statement: string): string => `${head}${'\n'.repeat(line - 2)}export const q = ${statement};\n`;

ruleTester.run('typed-sql', typedSql, {
  valid: [
    { filename, code: at(3, 'sql<{ Id: number; Name: string | null }>`SELECT Id, Name FROM users WHERE Id = ${1}`') },
    { filename, code: at(7, 'sql`SELECT Id FROM users WHERE ${sql.raw("1 = 1")}`') },
    { filename, code: at(8, 'sql`INSERT INTO users (Email) VALUES (${"a@b.c"})`') },
    { filename, code: at(9, 'sql`Id = ${1}`') },
    { filename, code: "const sql = (s: TemplateStringsArray) => s.join('');\nexport const q = sql`SELECT anything`;\n" },
    { filename: `${app}/../elsewhere.ts`, code: at(2, 'sql`SELECT Id, Email FROM users`') },
    // Q14: an undeclared column on a partial model is a doctor warning, not a lint error.
    { filename, code: at(5, 'sql<{ Nmae: unknown }>`SELECT Nmae FROM users`') },
    // A13: the type argument is newer than the manifest (what `--fix` leaves behind), so SQL005 is not checked against the stale row.
    { filename, code: at(4, 'sql<{ Name: string | null }>`SELECT Name FROM users`') },
  ],
  invalid: [
    {
      filename,
      code: at(2, 'sql`SELECT Id, Email FROM users`'),
      output: at(2, 'sql<{ Id: number; Email: string }>`SELECT Id, Email FROM users`'),
      errors: [{ messageId: 'missingRowType', data: { row: '{ Id: number; Email: string }' } }],
    },
    {
      filename,
      code: at(4, 'sql<{ Name: string }>`SELECT Name FROM users`'),
      output: at(4, 'sql<{ Name: string | null }>`SELECT Name FROM users`'),
      errors: [{ messageId: 'sqlProblem', data: { code: 'SQL005', message: 'sql<…> row differs from the query: Name can be null, declared string' } }],
    },
    {
      // The partial-model warning does not block the fix; the unmanaged column is typed `unknown`.
      filename,
      code: at(5, 'sql`SELECT Nmae FROM users`'),
      output: at(5, 'sql<{ Nmae: unknown }>`SELECT Nmae FROM users`'),
      errors: [{ messageId: 'missingRowType', data: { row: '{ Nmae: unknown }' } }],
    },
    {
      filename,
      code: at(10, 'sql`SELECT Id FROM usrs`'),
      errors: [{ messageId: 'sqlProblem', data: { code: 'SQL002', message: 'Table usrs is not the table of any model' } }],
    },
    {
      filename,
      code: at(6, 'sql`SELECT Id + 1 FROM users`'),
      errors: [{ messageId: 'unknownRowType', suggestions: [{ messageId: 'suggestRecord', output: at(6, 'sql<Record<string, unknown>>`SELECT Id + 1 FROM users`') }] }],
    },
    {
      filename,
      code: `${head}export const a = sql\`SELECT Id, Email FROM users\`;\nexport const b = sql\`SELECT Email FROM users WHERE Id = \${1}\`;\n`,
      errors: [{ messageId: 'staleManifest', line: 3, data: { manifest: 'app.manifest.json' } }],
    },
  ],
});

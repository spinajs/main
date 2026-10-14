import { fileURLToPath } from 'node:url';
import { ESLintUtils } from '@typescript-eslint/utils';

import { requireAccessible } from '../src/rules/require-accessible.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

// RuleTester registers its own describe/it with mocha.
const ruleTester = new ESLintUtils.RuleTester({
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixtures, sourceType: 'module' },
});

const imports = "import { SYSTEM, Note, SubTask, Task, authz, models, runAs } from './models';\n";
const code = (body: string) => `${imports}export async function run(id: number): Promise<unknown> {\n${body}\n}\n`;

ruleTester.run('require-accessible', requireAccessible, {
  valid: [
    code("return Task.where('a', 1).accessible('Task:read').first();"),
    code("return await Task.where('a', 1).accessible('Task:read');"),
    code("return Task.query().unscoped('nightly export').all();"),
    code("return runAs(SYSTEM, 'job', async () => Task.where('a', 1).first());"),
    code("return authz().runAs(SYSTEM, 'job', async function () { return Task.findOrFail([1, 2]); });"),
    code("return Note.where('a', 1).first();"),
    code('return await Note.findOrFail([1, 2]);'),
    code("const q = Task.where('a', 1);\nreturn q;"),
    code('return Task.create({ id: 1 });'),
    code('return Task.destroy(1);'),
    code('return models.Note.query().first();'),
    // single-object loads by primary key (overview decision 11)
    code('return Task.get(id);'),
    code('return await Task.findOrFail([id]);'),
    code("return Task.where('id', id).first();"),
    code("return await Task.where('id', id);"),
    code("return SubTask.where('id', id).firstOrFail();"),
  ],
  invalid: [
    { code: code("return Task.where('a', 1).first();"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.first()' } }] },
    { code: code("return Task.where('a', 1).populate('owner').take(5).all();"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.all()' } }] },
    { code: code('return await Task.query();'), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: 'await' } }] },
    { code: code('return await Task.all();'), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: 'await' } }] },
    { code: code("return Task.where('a', 1).then((rows) => rows);"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.then()' } }] },
    { code: code("return Task.where('a', 1).first().then(() => Task.where('a', 1).accessible('Task:read'));"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.first()' } }] },
    { code: code("return Task.where('id', id).where('a', 1).first();"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.first()' } }] },
    { code: code("return Task.where('id', [1, 2]).first();"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.first()' } }] },
    { code: code("return Note.where('id', id).first();"), options: [{ resources: ['Note'] }], errors: [{ messageId: 'unscopedQuery', data: { model: 'Note', call: '.first()' } }] },
    { code: code('return Task.findOrFail([1, 2]);'), errors: [{ messageId: 'unscopedShortcut', data: { model: 'Task', call: 'findOrFail' } }] },
    { code: code('return Task.count();'), errors: [{ messageId: 'unscopedShortcut', data: { model: 'Task', call: 'count' } }] },
    { code: code("return SubTask.where('a', 1).first();"), errors: [{ messageId: 'unscopedQuery', data: { model: 'SubTask', call: '.first()' } }] },
    { code: code('return models.Task.query().first();'), errors: [{ messageId: 'unscopedQuery', data: { model: 'models.Task', call: '.first()' } }] },
    {
      code: "import { Task as T } from './models';\nexport async function run(): Promise<unknown> {\nreturn T.where('a', 1).first();\n}\n",
      errors: [{ messageId: 'unscopedQuery', data: { model: 'T', call: '.first()' } }],
    },
    { code: code("return [1].map(async () => Task.where('a', 1).first());"), errors: [{ messageId: 'unscopedQuery', data: { model: 'Task', call: '.first()' } }] },
    { code: code("return Note.where('a', 1).first();"), options: [{ resources: ['Note'] }], errors: [{ messageId: 'unscopedQuery', data: { model: 'Note', call: '.first()' } }] },
  ],
});

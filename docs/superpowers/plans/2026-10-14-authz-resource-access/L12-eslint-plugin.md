# Lane L12: eslint plugin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** A new package `@spinajs/eslint-plugin-authz` with one typed rule, `@spinajs/authz/require-accessible` (design §8): a query chain on a class decorated with `@AccessResource` that reaches an executing call without `.accessible()`, `.unscoped()` or an enclosing `runAs(...)` is an error.

**Architecture:** Two source units: `access-resource.ts` answers "is this class symbol an `@AccessResource` model?" through the TypeScript checker (symbol → class declarations → decorators, following import aliases and `extends`); `rules/require-accessible.ts` walks the call chain that starts at a static call on such a class. The plugin entry exports `rules` and `configs.recommended`. ESLint 8 loads plugins with `require`, so the CJS build (`lib/cjs`) is the one ESLint uses.

**Tech Stack:** TypeScript (node16, ESM + CJS builds), `@typescript-eslint/utils` 5.62 (`ESLintUtils.RuleCreator`, `ESLintUtils.getParserServices`, `ESLintUtils.RuleTester`), `@typescript-eslint/parser` 5.62, ESLint 8.57, TypeScript 5.9 (also compiles under the root's TypeScript 7 build), mocha + ts-mocha + chai 4.

**Depends on:** nothing (wave 1). The rule matches the decorator by its name `AccessResource`, so it does not import `@spinajs/authz-orm` and does not wait for L3.

**Blocks:** none.

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?".
- New package scaffold copied from `packages/authz-abac` (overview Global Constraints): `.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.mocharc.json`, `.npmignore`, `.prettierrc`, `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `typedoc.json`; added to root `tsconfig.build.json`, `tsconfig.build.cjs.json` and root `package.json` `dependencies` as `"@spinajs/eslint-plugin-authz": "file:packages/eslint-plugin-authz"`. Version `3.0.0-alpha.0` (an authz package).
- Versions pinned to what the repo has (root `package.json` devDependencies, installed): `eslint` 8.57.1, `@typescript-eslint/parser|eslint-plugin|utils|type-utils` 5.62.0, `typescript` 5.9.3. No `@typescript-eslint/rule-tester` (v6+ only): v5 ships `ESLintUtils.RuleTester`.
- Not snapshotted (`scripts/api-snapshot.mjs` `FROZEN_PACKAGE = /^auth[nz](-|$)/` does not match `eslint-plugin-authz`): no snapshot, no RFC.
- Not wired into CI lint: CI does not run lint. Apps enable the rule themselves (README, Task 3).
- One file: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/<name>.test.ts`.
- Commit after every task.

## Decisions made in this lane

1. **Detection by checker, by name.** The callee object's type symbol (`checker.getTypeAtLocation(node).getSymbol()`, which is the class for `typeof Task`, through imports, renames and `const M = Task`) is followed to its class declarations; a decorator counts when its callee resolves to a symbol named `AccessResource` (so `import { AccessResource as AR }` and `orm.AccessResource(...)` count). A subclass of such a class counts. Results are cached per symbol per file.
2. **Compiled models.** Decorators are not emitted into `.d.ts`, so a model a package ships compiled (`@spinajs/users`' `User`, `authz-queue`'s `JobModel`) cannot be detected. The option `resources: string[]` names extra classes (by class name). The runtime guard of design §8 still sees them.
3. **What is a query.** The chain starts at a static member of the model (`packages/orm/src/model.ts:418-612`):
   - query roots (return a select builder): `where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`, `populate`;
   - other static reads return a promise at once and have no builder to scope; outside `runAs` they are reported with their own message, except single-object loads (below): `getOrNew`, `getOrCreate`, `first`, `last`, `newest`, `oldest`, `count`, `exists`, and `find` / `findOrFail` with anything but a one-element array literal;
   - writes (`create`, `insert`, `update`, `destroy`, `truncate`, `transaction`) are not checked: the guard of design §8 covers selects.
   A root call is followed through `.member(...)` calls. A `.accessible(` or `.unscoped(` before the first executing member clears it. Executing members (`packages/orm/src/interfaces.ts:1165-1172,1359-1430`): `first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`, `resultExists`, `selectCount`, `then`. A chain that ends unexecuted is reported when it is the operand of `await`.
4. **Single-object loads are not flagged** (overview decision 11, the same rule as L3's runtime guard, `L03-authz-orm-core.md` "Exempt"): static `get(v)` and `getOrFail(v)` (one key by signature), `find([v])` / `findOrFail([v])` with a one-element array literal, and a chain whose root is `where('<pk>', v)` with a string-literal column equal to the model's primary key, a value that is not an array or object literal, and no other member whose name contains `where`. The primary key is the property decorated `@Primary()` on the class or a class it extends; when none is visible (a `.d.ts` base) `where(pk, v)` is treated as multi-row and reported, which errs on the side of the guard.
5. **`runAs`.** Any enclosing arrow or function expression passed as an argument to a call whose callee is `runAs` or `<anything>.runAs` exempts the chain, whatever the principal argument (the rule cannot tell `SYSTEM` from another principal statically; design §8 says "an enclosing `runAs`").
6. **Known misses (documented):** a builder stored in a variable and executed later, a builder returned unexecuted from an `async` function, `Promise.all([...builders])`, instance relations (`project.tasks`), `populate('tasks')` of an `@AccessResource` child type, and models known only from `.d.ts` without the `resources` option. The runtime guard catches these in the `test` env.

## Files

- Create: `packages/eslint-plugin-authz/` scaffold (11 files listed in Global Constraints), `README.md`
- Create: `packages/eslint-plugin-authz/src/access-resource.ts`, `src/rules/require-accessible.ts`, `src/index.ts`
- Create: `packages/eslint-plugin-authz/test/fixtures/tsconfig.json`, `test/fixtures/file.ts`, `test/fixtures/models.ts`
- Create: `packages/eslint-plugin-authz/test/access-resource.test.ts`, `test/require-accessible.test.ts`, `test/plugin.test.ts`
- Modify: root `tsconfig.build.json` (after L75), `tsconfig.build.cjs.json` (after L74), `package.json` (`dependencies`, after `@spinajs/authz-abac` L90)

---

### Task 1: Package scaffold, `@AccessResource` class and primary-key detection

**Files:**
- Create: the scaffold, `src/access-resource.ts`, `src/index.ts` (temporary content), fixtures, `test/access-resource.test.ts`
- Modify: root `tsconfig.build.json`, `tsconfig.build.cjs.json`, `package.json`

**Interfaces:**
- Produces: `isAccessResourceClass(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, extra: ReadonlySet<string>, cache: Map<ts.Symbol, boolean>): boolean`, `primaryKeyOf(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined` (the `@Primary()` property).

- [ ] **Step 1: Copy the scaffold**

Run (repo root, bash):

```bash
mkdir -p packages/eslint-plugin-authz/src/rules packages/eslint-plugin-authz/test/fixtures
for f in .eslintignore .eslintrc.cjs .gitignore .npmignore .prettierrc typedoc.json; do cp packages/authz-abac/$f packages/eslint-plugin-authz/$f; done
```

Create `packages/eslint-plugin-authz/package.json`:

```json
{
  "name": "@spinajs/eslint-plugin-authz",
  "version": "3.0.0-alpha.0",
  "description": "ESLint rules for SpinaJS authorization: require .accessible() on @AccessResource queries",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "pretest": "npm run compile",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "authz",
    "eslint",
    "eslintplugin",
    "eslint-plugin"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@typescript-eslint/utils": "^5.62.0"
  },
  "peerDependencies": {
    "@typescript-eslint/parser": "^5.48.2",
    "eslint": "^8.32.0",
    "typescript": ">=4.8"
  }
}
```

Create `packages/eslint-plugin-authz/.mocharc.json` (typed linting builds a TS program on the first case, which can take several seconds):

```json
{
  "extensions": [
    "ts"
  ],
  "spec": [
    "test/**/*.test.ts"
  ],
  "timeout": 60000,
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

Create `packages/eslint-plugin-authz/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["test/fixtures/**/*"]
}
```

Create `packages/eslint-plugin-authz/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"]
}
```

Create `packages/eslint-plugin-authz/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"]
}
```

In root `tsconfig.build.json`, after `{ "path": "packages/authz-abac/tsconfig.mjs.json" },` (L75) add:

```json
    { "path": "packages/eslint-plugin-authz/tsconfig.mjs.json" },
```

In root `tsconfig.build.cjs.json`, after `{ "path": "./packages/authz-abac/tsconfig.cjs.json" },` (L74) add:

```json
    { "path": "./packages/eslint-plugin-authz/tsconfig.cjs.json" },
```

In root `package.json` `dependencies`, after `"@spinajs/authz-abac": "file:packages/authz-abac",` add:

```json
    "@spinajs/eslint-plugin-authz": "file:packages/eslint-plugin-authz",
```

- [ ] **Step 2: Add the fixtures**

Create `packages/eslint-plugin-authz/test/fixtures/tsconfig.json` (the TS project the typed tests lint against; `file.ts` is the file name `ESLintUtils.RuleTester` gives every case):

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "experimentalDecorators": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["file.ts", "models.ts"]
}
```

Create `packages/eslint-plugin-authz/test/fixtures/file.ts`:

```ts
export {};
```

Create `packages/eslint-plugin-authz/test/fixtures/models.ts` (a self-contained stand-in for `@spinajs/orm` and `@spinajs/authz-orm`, so the tests build no real dependency graph):

```ts
export function AccessResource(_type: string): ClassDecorator {
  return () => undefined;
}

export function Primary(): PropertyDecorator {
  return () => undefined;
}

export const SYSTEM = { type: 'system', id: 'system' };

export declare function runAs<T>(principal: unknown, reason: string, fn: () => Promise<T>): Promise<T>;

export declare function authz(): { runAs: typeof runAs };

export interface Query<T> extends PromiseLike<T[]> {
  where(column: string, value: unknown): Query<T>;
  accessible(permission: string): Query<T>;
  unscoped(reason: string): Query<T>;
  populate(relation: string): Query<T>;
  take(count: number): Query<T>;
  first(): Promise<T>;
  firstOrFail(): Promise<T>;
  all(): Promise<T[]>;
  execute(): Promise<T[]>;
}

export declare class Model {
  static where<M extends typeof Model>(this: M, column: string, value: unknown): Query<InstanceType<M>>;
  static query<M extends typeof Model>(this: M): Query<InstanceType<M>>;
  static all<M extends typeof Model>(this: M): Query<InstanceType<M>>;
  static get<M extends typeof Model>(this: M, pk: unknown): Promise<InstanceType<M>>;
  static findOrFail<M extends typeof Model>(this: M, pks: unknown[]): Promise<InstanceType<M>[]>;
  static count(): Promise<number>;
  static create<M extends typeof Model>(this: M, data: Partial<InstanceType<M>>): Promise<InstanceType<M>>;
  static destroy(pk: unknown): Promise<void>;
}

@AccessResource('task')
export class Task extends Model {
  @Primary()
  public id!: number;
}

export class SubTask extends Task {}

export class Note extends Model {
  public id!: number;
}

export const models = { Task, Note };
```

- [ ] **Step 3: Write the failing test**

Create `packages/eslint-plugin-authz/test/access-resource.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { isAccessResourceClass, primaryKeyOf } from '../src/access-resource.js';

const MODELS = join(fileURLToPath(new URL('./fixtures', import.meta.url)), 'models.ts');

describe('isAccessResourceClass', function () {
  let checker: ts.TypeChecker;
  let exported: ts.Symbol[];

  before(() => {
    const program = ts.createProgram({ rootNames: [MODELS], options: { experimentalDecorators: true, strict: true, noEmit: true, types: [] } });
    checker = program.getTypeChecker();
    exported = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(MODELS)!)!);
  });

  const is = (name: string, extra: string[] = []) => isAccessResourceClass(exported.find((s) => s.name === name), checker, new Set(extra), new Map());

  it('accepts a class decorated with @AccessResource', () => {
    expect(is('Task')).to.eq(true);
  });

  it('accepts a subclass of one', () => {
    expect(is('SubTask')).to.eq(true);
  });

  it('refuses plain classes, other values and no symbol', () => {
    expect(is('Note')).to.eq(false);
    expect(is('Model')).to.eq(false);
    expect(is('models')).to.eq(false);
    expect(isAccessResourceClass(undefined, checker, new Set(), new Map())).to.eq(false);
  });

  it('accepts a class named in the extra set', () => {
    expect(is('Note', ['Note'])).to.eq(true);
  });

  it('finds the @Primary() property of a class or its base, and nothing without one', () => {
    const pk = (name: string) => primaryKeyOf(exported.find((s) => s.name === name), checker);
    expect(pk('Task')).to.eq('id');
    expect(pk('SubTask')).to.eq('id');
    expect(pk('Note')).to.eq(undefined);
    expect(primaryKeyOf(undefined, checker)).to.eq(undefined);
  });
});
```

Create a temporary `packages/eslint-plugin-authz/src/index.ts` (Task 2 replaces it):

```ts
export * from './access-resource.js';
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/access-resource.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/access-resource.js'`.

- [ ] **Step 5: Write the detection**

Create `packages/eslint-plugin-authz/src/access-resource.ts`:

```ts
import ts from 'typescript';

const ACCESS_RESOURCE = 'AccessResource';
const PRIMARY = 'Primary';

function decoratorName(decorator: ts.Decorator, checker: ts.TypeChecker): string | undefined {
  const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  const named = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(named);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.name ?? (ts.isIdentifier(named) ? named.text : undefined);
}

const decoratorsOf = (node: ts.Node): readonly ts.Decorator[] => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);

function classDeclarations(symbol: ts.Symbol): ts.ClassLikeDeclaration[] {
  return (symbol.declarations ?? []).filter((d): d is ts.ClassLikeDeclaration => ts.isClassDeclaration(d) || ts.isClassExpression(d));
}

function resolve(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function baseOf(declaration: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.Symbol | undefined {
  const base = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  return base ? (checker.getTypeAtLocation(base.expression).getSymbol() ?? checker.getSymbolAtLocation(base.expression)) : undefined;
}

/**
 * Whether `symbol` is a class decorated with `@AccessResource`, or extends one. A class known only from a
 * `.d.ts` has lost its decorators, so it counts only when its name is in `extra`.
 */
export function isAccessResourceClass(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, extra: ReadonlySet<string>, cache: Map<ts.Symbol, boolean>): boolean {
  if (!symbol) return false;
  symbol = resolve(symbol, checker);
  const known = cache.get(symbol);
  if (known !== undefined) return known;
  // Provisional answer, so an inheritance cycle in a broken program ends.
  cache.set(symbol, false);

  let result = extra.has(symbol.name);
  for (const declaration of classDeclarations(symbol)) {
    if (result) break;
    result = decoratorsOf(declaration).some((d) => decoratorName(d, checker) === ACCESS_RESOURCE);
    if (!result) result = isAccessResourceClass(baseOf(declaration, checker), checker, extra, cache);
  }

  cache.set(symbol, result);
  return result;
}

/** The property decorated with `@Primary()` on the class or a class it extends; undefined when none is visible (a `.d.ts` base). */
export function primaryKeyOf(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, seen: Set<ts.Symbol> = new Set()): string | undefined {
  if (!symbol) return undefined;
  symbol = resolve(symbol, checker);
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);

  for (const declaration of classDeclarations(symbol)) {
    for (const member of declaration.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && decoratorsOf(member).some((d) => decoratorName(d, checker) === PRIMARY)) return member.name.text;
    }
    const inherited = primaryKeyOf(baseOf(declaration, checker), checker, seen);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/access-resource.test.ts`
Expected: PASS, `5 passing`, `0 failing`.

- [ ] **Step 7: Build wiring**

Run (repo root): `npm install && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.cjs.json`
Expected: exits 0; `packages/eslint-plugin-authz/lib/mjs/access-resource.js` and `lib/cjs/access-resource.js` exist; `node_modules/@spinajs/eslint-plugin-authz` links to the package.

- [ ] **Step 8: Commit**

```bash
git add packages/eslint-plugin-authz tsconfig.build.json tsconfig.build.cjs.json package.json package-lock.json
git commit -m "chore(eslint-plugin-authz): package scaffold and @AccessResource class detection"
```

---

### Task 2: The `require-accessible` rule

**Files:**
- Create: `packages/eslint-plugin-authz/src/rules/require-accessible.ts`
- Replace: `packages/eslint-plugin-authz/src/index.ts`
- Test: `packages/eslint-plugin-authz/test/require-accessible.test.ts`

**Interfaces:**
- Consumes: `isAccessResourceClass` (Task 1).
- Produces: `requireAccessible` (`TSESLint.RuleModule<'unscopedQuery' | 'unscopedShortcut', [RequireAccessibleOptions]>`), `interface RequireAccessibleOptions { resources?: readonly string[] }`, `QUERY_ROOTS`, `PRIMARY_KEY_READS`, `KEY_LIST_READS`, `READ_SHORTCUTS`, `EXECUTING_MEMBERS`, `SCOPING_MEMBERS`; plugin `rules: { 'require-accessible': requireAccessible }`.

- [ ] **Step 1: Write the failing test**

Create `packages/eslint-plugin-authz/test/require-accessible.test.ts` (verified against the fixture in a prototype: 32 cases pass):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/require-accessible.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/rules/require-accessible.js'`.

- [ ] **Step 3: Write the rule**

Create `packages/eslint-plugin-authz/src/rules/require-accessible.ts`:

```ts
import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';

import { isAccessResourceClass, primaryKeyOf } from '../access-resource.js';

/** Static members of an ORM model that start a select query builder. */
export const QUERY_ROOTS: ReadonlySet<string> = new Set(['where', 'query', 'select', 'all', 'whereExists', 'whereNotExists', 'populate']);

/** Static reads of one primary-key value (`wherePk`): single-object loads, covered by the route's check-before. */
export const PRIMARY_KEY_READS: ReadonlySet<string> = new Set(['get', 'getOrFail']);

/** Static reads of a primary-key list (`whereAnyPk`): a single-object load only with exactly one value. */
export const KEY_LIST_READS: ReadonlySet<string> = new Set(['find', 'findOrFail']);

/** Other static reads that return a promise at once, so there is no builder to scope. */
export const READ_SHORTCUTS: ReadonlySet<string> = new Set(['getOrNew', 'getOrCreate', 'first', 'last', 'newest', 'oldest', 'count', 'exists']);

/** Builder members that run the query (`@spinajs/orm` `ISelectQueryBuilder`, `ILimitBuilder`, `IBuilder`). */
export const EXECUTING_MEMBERS: ReadonlySet<string> = new Set(['first', 'firstOrFail', 'firstOrThrow', 'orThrow', 'all', 'execute', 'asRaw', 'resultExists', 'selectCount', 'then']);

export const SCOPING_MEMBERS: ReadonlySet<string> = new Set(['accessible', 'unscoped']);

export interface RequireAccessibleOptions {
  /** Class names to treat as `@AccessResource` models: decorators do not survive into `.d.ts` files. */
  readonly resources?: readonly string[];
}

export type RequireAccessibleMessageIds = 'unscopedQuery' | 'unscopedShortcut';

type Chain = { call: TSESTree.CallExpression; name: string }[];

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

const memberName = (node: TSESTree.MemberExpression): string | undefined => (!node.computed && node.property.type === AST_NODE_TYPES.Identifier ? node.property.name : undefined);

function isRunAsCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== AST_NODE_TYPES.CallExpression || !call.arguments.some((a) => a === fn)) return false;
  const callee = call.callee;
  return (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'runAs') || (callee.type === AST_NODE_TYPES.MemberExpression && memberName(callee) === 'runAs');
}

function insideRunAs(node: TSESTree.Node): boolean {
  for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
    if ((n.type === AST_NODE_TYPES.ArrowFunctionExpression || n.type === AST_NODE_TYPES.FunctionExpression) && isRunAsCallback(n)) return true;
  }
  return false;
}

/** The calls chained on `root` (`root.a().b()`) with their member names; the chain ends at anything else. */
function chainOf(root: TSESTree.CallExpression): Chain {
  const out: Chain = [];
  let node: TSESTree.Node = root;
  for (;;) {
    const member: TSESTree.Node | undefined = node.parent;
    if (member?.type !== AST_NODE_TYPES.MemberExpression || member.object !== node) break;
    const call: TSESTree.Node | undefined = member.parent;
    const name = memberName(member);
    if (call?.type !== AST_NODE_TYPES.CallExpression || call.callee !== member || name === undefined) break;
    out.push({ call, name });
    node = call;
  }
  return out;
}

const isOneKeyList = (args: readonly TSESTree.CallExpressionArgument[]): boolean =>
  args.length === 1 && args[0].type === AST_NODE_TYPES.ArrayExpression && args[0].elements.length === 1 && args[0].elements[0]?.type !== AST_NODE_TYPES.SpreadElement;

/** `where('<pk>', value)` with no other where in the chain: one primary-key equality, as the runtime guard reads it. */
function isPrimaryKeyWhere(root: TSESTree.CallExpression, chain: Chain, pk: string | undefined): boolean {
  if (pk === undefined || root.arguments.length !== 2) return false;
  const [column, value] = root.arguments;
  if (column.type !== AST_NODE_TYPES.Literal || column.value !== pk) return false;
  if (value.type === AST_NODE_TYPES.ArrayExpression || value.type === AST_NODE_TYPES.ObjectExpression || value.type === AST_NODE_TYPES.SpreadElement) return false;
  return !chain.some(({ name }) => /where/i.test(name));
}

export const requireAccessible = createRule<[RequireAccessibleOptions], RequireAccessibleMessageIds>({
  name: 'require-accessible',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require .accessible(), .unscoped() or an enclosing runAs() on multi-row queries of @AccessResource models',
      recommended: 'error',
      requiresTypeChecking: true,
    },
    messages: {
      unscopedQuery: '{{model}} is an @AccessResource model: this query reaches {{call}} without .accessible(permission), .unscoped(reason) or an enclosing runAs(SYSTEM, reason).',
      unscopedShortcut: '{{model}}.{{call}}() reads more than one primary key of an @AccessResource model with nothing to scope: call it inside runAs(SYSTEM, reason), or use {{model}}.query() with .accessible(permission).',
    },
    schema: [
      {
        type: 'object',
        properties: { resources: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ resources: [] }],
  create(context, [options]) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const extra = new Set(options.resources ?? []);
    const cache = new Map<ts.Symbol, boolean>();

    const classOf = (node: TSESTree.Node): ts.Symbol | undefined => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getTypeAtLocation(tsNode).getSymbol() ?? checker.getSymbolAtLocation(tsNode);
    };

    return {
      CallExpression(node): void {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) return;
        const root = memberName(callee);
        if (root === undefined || PRIMARY_KEY_READS.has(root)) return;
        if (!QUERY_ROOTS.has(root) && !KEY_LIST_READS.has(root) && !READ_SHORTCUTS.has(root)) return;
        if (callee.object.type !== AST_NODE_TYPES.Identifier && callee.object.type !== AST_NODE_TYPES.MemberExpression) return;
        const model = classOf(callee.object);
        if (!isAccessResourceClass(model, checker, extra, cache) || insideRunAs(node)) return;

        const name = context.getSourceCode().getText(callee.object);
        if (!QUERY_ROOTS.has(root)) {
          if (KEY_LIST_READS.has(root) && isOneKeyList(node.arguments)) return;
          context.report({ node, messageId: 'unscopedShortcut', data: { model: name, call: root } });
          return;
        }

        const chain = chainOf(node);
        if (root === 'where' && isPrimaryKeyWhere(node, chain, primaryKeyOf(model, checker))) return;
        for (const { call, name: member } of chain) {
          if (SCOPING_MEMBERS.has(member)) return;
          if (EXECUTING_MEMBERS.has(member)) {
            context.report({ node: call, messageId: 'unscopedQuery', data: { model: name, call: `.${member}()` } });
            return;
          }
        }

        const outer = chain.length > 0 ? chain[chain.length - 1].call : node;
        if (outer.parent?.type === AST_NODE_TYPES.AwaitExpression) {
          context.report({ node: outer.parent, messageId: 'unscopedQuery', data: { model: name, call: 'await' } });
        }
      },
    };
  },
});
```

Replace `packages/eslint-plugin-authz/src/index.ts` with:

```ts
import { requireAccessible } from './rules/require-accessible.js';

export { isAccessResourceClass, primaryKeyOf } from './access-resource.js';
export * from './rules/require-accessible.js';

// ESLint 8 reads `rules` and `configs` off the module it requires (lib/cjs).
export const rules = {
  'require-accessible': requireAccessible,
};

export const configs = {
  recommended: {
    plugins: ['@spinajs/authz'],
    rules: { '@spinajs/authz/require-accessible': 'error' },
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/require-accessible.test.ts`
Expected: PASS, `32 passing`, `0 failing`. A `DeprecationWarning: ... context.parserServices` line is expected: `@typescript-eslint/utils` 5's `getParserServices` reads it; it goes away with v6.

- [ ] **Step 5: Commit**

```bash
git add packages/eslint-plugin-authz/src packages/eslint-plugin-authz/test/require-accessible.test.ts
git commit -m "feat(eslint-plugin-authz): require-accessible rule over @AccessResource query chains"
```

---

### Task 3: Plugin config, README, verification

**Files:**
- Create: `packages/eslint-plugin-authz/test/plugin.test.ts`, `packages/eslint-plugin-authz/README.md`

**Interfaces:**
- Consumes: `rules`, `configs` (Task 2).

- [ ] **Step 1: Write the test**

Create `packages/eslint-plugin-authz/test/plugin.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { TSESLint } from '@typescript-eslint/utils';

import * as plugin from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('@spinajs/eslint-plugin-authz', () => {
  it('exports the rule and a recommended config that enables it', () => {
    expect(Object.keys(plugin.rules)).to.deep.eq(['require-accessible']);
    expect(plugin.configs.recommended.rules).to.deep.eq({ '@spinajs/authz/require-accessible': 'error' });
  });

  it('reports through ESLint with plugin:@spinajs/authz/recommended', async () => {
    // The repo has no @types/eslint; TSESLint.ESLint is the typed wrapper. Its v5 ConfigOverride type
    // wrongly requires `files`, which ESLint 8 refuses at the top level, hence the cast.
    const eslint = new TSESLint.ESLint({
      cwd: fixtures,
      useEslintrc: false,
      plugins: { '@spinajs/authz': plugin as unknown as TSESLint.Linter.Plugin },
      overrideConfig: {
        parser: '@typescript-eslint/parser',
        parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixtures, sourceType: 'module' },
        extends: ['plugin:@spinajs/authz/recommended'],
      } as unknown as TSESLint.ESLint.ESLintOptions['overrideConfig'],
    });

    const [result] = await eslint.lintText("import { Task } from './models';\nexport const run = () => Task.where('a', 1).first();\n", { filePath: `${fixtures}/file.ts` });

    expect(result.messages.map((m) => [m.ruleId, m.line])).to.deep.eq([['@spinajs/authz/require-accessible', 2]]);
    expect(result.messages[0].message).to.match(/^Task is an @AccessResource model: this query reaches \.first\(\)/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/eslint-plugin-authz && npx ts-mocha -p tsconfig.json test/plugin.test.ts`
Expected: PASS, `2 passing`, `0 failing` (the ESLint call was verified in a prototype against the fixture).

- [ ] **Step 3: Write the README**

Create `packages/eslint-plugin-authz/README.md`:

````markdown
# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization (design `docs/plans/2026-10-14-authz-resource-access-design.md` §8).

## Install

```sh
npm i -D @spinajs/eslint-plugin-authz @typescript-eslint/parser eslint@8 typescript
```

The rule is typed: ESLint must run with `@typescript-eslint/parser` and a `parserOptions.project`.

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  plugins: ['@spinajs/authz'],
  extends: ['plugin:@spinajs/authz/recommended'],
  // or: rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User'] }] },
};
```

SpinaJS's own CI does not run ESLint; apps add the rule to their lint step.

## `require-accessible`

A select on an `@AccessResource` model must call `.accessible(permission)`, use `.unscoped(reason)`, or run
inside `runAs(SYSTEM, reason)`. The rule reports:

- a chain from a static query member (`where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`,
  `populate`) that reaches `first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`,
  `resultExists`, `selectCount` or `then`, or is awaited, with no `.accessible(` or `.unscoped(` before that;
- a static read that returns a promise at once (`getOrNew`, `getOrCreate`, `first`, `last`, `newest`,
  `oldest`, `count`, `exists`, and `find` / `findOrFail` with more than one key): there is no builder to
  scope, so run it in `runAs(SYSTEM, reason)`, or query with `.accessible()`.

Single-object loads are not reported, as the runtime guard does not refuse them: `get(id)`,
`getOrFail(id)`, `find([id])`, `findOrFail([id])`, and `where('<primary key>', id)` with no other where
(the primary key is the `@Primary()` property). The route's `@Access` check-before covers them.

Any arrow or function passed to `runAs(...)` or `x.runAs(...)` exempts what it contains. Writes (`create`,
`insert`, `update`, `destroy`) are not checked.

A model is an access resource when its class, or a class it extends, has `@AccessResource(...)`, however
the decorator or the class is imported or renamed.

### Options

- `resources: string[]`: class names to treat as access resources. Decorators do not survive into `.d.ts`
  files, so models a package ships compiled (`User` from `@spinajs/users`, `JobModel` from
  `@spinajs/authz-queue`) are only found when listed here.

### What it misses

A builder kept in a variable and executed later, a builder returned unexecuted from an `async` function,
`Promise.all` over builders, instance relations, and `populate()` of an access-resource child. The runtime
guard (an `AuthzConfigError` in the `test` env) catches those.
````

- [ ] **Step 4: Whole package and root build**

Run: `cd packages/eslint-plugin-authz && npm test`
Expected: `39 passing` (5 + 32 + 2), `0 failing`.

Run (repo root): `npm run build`
Expected: exits 0; `packages/eslint-plugin-authz/lib/cjs/package.json` is `{"type":"commonjs"}` (written by `prepare-module-support`).

Run (repo root): `node -e "const p=require('./packages/eslint-plugin-authz/lib/cjs/index.js'); console.log(Object.keys(p.rules), Object.keys(p.configs))"`
Expected: `[ 'require-accessible' ] [ 'recommended' ]` (ESLint 8 loads this file).

- [ ] **Step 5: Commit**

```bash
git add packages/eslint-plugin-authz
git commit -m "docs(eslint-plugin-authz): recommended config, README, plugin loading test"
```

---

## Contract issues found

1. **Unscoped-by-name.** The rule accepts `.unscoped(` by name and does not check its argument is a non-empty reason; L3's `.unscoped(reason)` should throw on an empty one. Non-blocking.
2. **Primary key by property name.** `where('<pk>', v)` is exempt only when the literal equals the `@Primary()` property name; L3's guard compares the compiled column (`entry.idColumn`). A model whose primary-key column differs from its property name and is queried by column name is reported by the rule but passes the guard (false positive, fail closed). Non-blocking.

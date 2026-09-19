# ORM View and Event Query Builders Implementation Plan (stage 1 - spinajs)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `schema().createView()` and a reworked `schema().createEvent()` / `dropEvent()` to `@spinajs/orm`, compiled per dialect for mysql, sqlite, postgres and mssql, throwing `MethodNotImplemented` for anything an engine does not have.

**Architecture:** One abstract compiler per statement in `@spinajs/orm`, one shared SQL compiler in `@spinajs/orm-sql` that emits only the portable core and throws for every optional clause, one subclass per driver that enables the clauses its engine has. Values are never bound in these statements: a new `LiteralQuoter` DI service (per driver, like `IdentifierQuoter`) writes them into the SQL text through `inlineBindings()`.

**Tech Stack:** TypeScript (ESM, node16 resolution), `@spinajs/di` containers, mocha + chai through `ts-mocha`, luxon, `mysql2`, `pg`, `mssql`, `sqlite3`.

**Spec:** `docs/superpowers/specs/2026-09-19-orm-view-event-builders-design.md`

## Global Constraints

- Work in a dedicated worktree, never in `C:\Users\grzch\SourceCodes\Spinajs\main`: the yourscreen-backend workspaces consume that checkout's built `lib/` through junctions. Create it once: `git -C C:\Users\grzch\SourceCodes\Spinajs\main worktree add ..\view-event-builders -b feat/orm-view-event-builders master`, then in `C:\Users\grzch\SourceCodes\Spinajs\view-event-builders` run `npm install` and `npm run build`. All paths below are relative to that worktree.
- Packages consume each other through built `lib/mjs`, not through `src`. After changing `packages/orm/src` run `npm run compile` in `packages/orm`; after changing `packages/orm-sql/src` run `npm run compile` in `packages/orm-sql`. A downstream test that cannot see a new export means this step was skipped.
- Run one test file from inside its package: `npx ts-mocha -p tsconfig.json test/<file>.test.ts`. The warning `Cannot find any files matching pattern "packages/configuration/test/*.test.ts"` is noise from the root `.mocharc`.
- A clause an engine does not have throws `MethodNotImplemented` (`@spinajs/exceptions`). Nothing is simulated: no `DROP` + `CREATE` for a missing `OR REPLACE`, no timers, no SQL Server Agent.
- View and event compilers always return `bindings: []`.
- Anything interpolated into SQL unquoted (algorithm, security, check option, interval unit) is validated against an allow-list in the builder.
- Comments, identifiers and commit messages in English. Comment only what the code cannot say: a workaround, a non-obvious reason, an external constraint. No essays.
- Commits follow the repo's conventional style: `feat(orm): ...`, `feat(orm-mysql): ...`, `test(...)`, `docs(...)`.
- First commit on the branch adds the spec and this plan (`docs/superpowers/`); copy both files from `Spinajs\main\docs\superpowers\` into the worktree before Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `packages/orm/src/quoting.ts` | + `LiteralQuoter` abstraction |
| `packages/orm/src/interfaces.ts` | + `CreateViewCompiler`; event compilers return a single output |
| `packages/orm/src/builders.ts` | + `CreateViewQueryBuilder`, `createView()`; reworked `EventQueryBuilder`, `DropEventQueryBuilder`, `createEvent()`; `ScheduleQueryBuilder` removed |
| `packages/orm-sql/src/literals.ts` (new) | `SqlLiteralQuoter`, `inlineBindings()` |
| `packages/orm-sql/src/views.ts` (new) | `SqlCreateViewQueryCompiler` |
| `packages/orm-sql/src/compilers.ts` | rewritten `SqlEventQueryCompiler`, `SqlDropEventQueryCompiler`; + `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` |
| `packages/orm-{mysql,sqlite,postgres,mssql}/src/compilers.ts` | the driver's `*CreateViewCompiler` |
| `packages/orm-{mysql,postgres,mssql}/src/statements.ts` | the driver's `*LiteralQuoter` (next to its `IdentifierQuoter`) |
| `packages/orm-*/src/index.ts` | registrations in `resolve()` |
| `packages/orm-sql/test/{literals,view,event}.test.ts` (new) | shared layer tests |
| `packages/orm-{mysql,sqlite,postgres,mssql}/test/view.test.ts` (new) | dialect matrix per driver |
| `packages/orm-mysql/test/event.test.ts` (new) | mysql event SQL |
| `packages/orm-*/test/dialect.test.ts` | registration lists, unsupported events |
| `packages/orm-mysql/test/mysql.test.ts`, `packages/orm-mssql/test/mssql.test.ts` | live tests |
| `packages/orm/docs/10-schema-and-migrations.md`, `packages/orm-mysql/docs/02-dialect-notes.md`, `packages/orm-sql/docs/02-compilers.md` | docs |

---

### Task 1: `LiteralQuoter`, `SqlLiteralQuoter` and `inlineBindings`

**Files:**
- Modify: `packages/orm/src/quoting.ts` (append)
- Create: `packages/orm-sql/src/literals.ts`
- Modify: `packages/orm-sql/src/index.ts` (one export line)
- Modify: `packages/orm-sql/test/fixture.ts` (one import, one registration)
- Test: `packages/orm-sql/test/literals.test.ts`

**Interfaces:**
- Produces: `abstract class LiteralQuoter { abstract quote(value: unknown): string }` from `@spinajs/orm`.
- Produces: `class SqlLiteralQuoter extends LiteralQuoter` with `constructor(container: IContainer)`, overridable `protected quoteString(value: string): string`, `protected quoteBoolean(value: boolean): string`, `protected quoteDate(value: Date | DateTime): string`; and `function inlineBindings(expression: string, bindings: unknown[], quoter: LiteralQuoter): string`, both from `@spinajs/orm-sql`.

- [ ] **Step 1: Write the failing test**

Create `packages/orm-sql/test/literals.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { LiteralQuoter, Orm } from '@spinajs/orm';

import { inlineBindings, SqlLiteralQuoter } from '../src/literals.js';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

describe('literal quoting', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const quoter = () => DI.get(Orm)!.Connections.get('sqlite')!.Container.resolve<LiteralQuoter>(LiteralQuoter);

  it('resolves from the driver container', () => {
    expect(quoter()).to.be.instanceOf(SqlLiteralQuoter);
  });

  it('writes null and undefined as NULL', () => {
    expect(quoter().quote(null)).to.eq('NULL');
    expect(quoter().quote(undefined)).to.eq('NULL');
  });

  it('writes numbers and bigints as they are', () => {
    expect(quoter().quote(42)).to.eq('42');
    expect(quoter().quote(-1.5)).to.eq('-1.5');
    expect(quoter().quote(10n)).to.eq('10');
  });

  it('refuses a non finite number', () => {
    expect(() => quoter().quote(NaN)).to.throw(InvalidArgument);
    expect(() => quoter().quote(Infinity)).to.throw(InvalidArgument);
  });

  it('writes booleans as 1 and 0', () => {
    expect(quoter().quote(true)).to.eq('1');
    expect(quoter().quote(false)).to.eq('0');
  });

  it('quotes a string and doubles embedded quotes', () => {
    expect(quoter().quote('admin')).to.eq(`'admin'`);
    expect(quoter().quote(`it's`)).to.eq(`'it''s'`);
    expect(quoter().quote(`'; DROP TABLE x; --`)).to.eq(`'''; DROP TABLE x; --'`);
  });

  it('writes dates through the datetime converter of the driver', () => {
    expect(quoter().quote(DateTime.fromSQL('2025-11-21 05:27:43'))).to.eq(`'2025-11-21 05:27:43.000'`);
    expect(quoter().quote(new Date(2025, 10, 21, 5, 27, 43))).to.eq(`'2025-11-21 05:27:43.000'`);
  });

  it('refuses a value it has no literal for', () => {
    expect(() => quoter().quote({})).to.throw(InvalidArgument);
    expect(() => quoter().quote([1])).to.throw(InvalidArgument);
    expect(() => quoter().quote(Buffer.from('x'))).to.throw(InvalidArgument);
  });
});

describe('inlineBindings', () => {
  const marker = { quote: (value: unknown) => `<${String(value)}>` } as LiteralQuoter;

  it('returns the expression untouched when there are no bindings', () => {
    expect(inlineBindings('SELECT ? FROM t', [], marker)).to.eq('SELECT ? FROM t');
  });

  it('replaces placeholders in order', () => {
    expect(inlineBindings('a = ? AND b = ?', [1, 'x'], marker)).to.eq('a = <1> AND b = <x>');
  });

  it('skips placeholders inside quoted regions', () => {
    expect(inlineBindings(`SELECT '?', "?", \`?\`, ?`, [7], marker)).to.eq(`SELECT '?', "?", \`?\`, <7>`);
  });

  it('reads a doubled quote as an escaped quote', () => {
    expect(inlineBindings(`a = 'it''s ?' AND b = ?`, [7], marker)).to.eq(`a = 'it''s ?' AND b = <7>`);
  });

  it('skips placeholders inside comments', () => {
    expect(inlineBindings('SELECT ? -- why?\n, ? /* really? */', [1, 2], marker)).to.eq('SELECT <1> -- why?\n, <2> /* really? */');
  });

  it('throws when placeholders outnumber bindings', () => {
    expect(() => inlineBindings('a = ? AND b = ?', [1], marker)).to.throw(InvalidOperation);
  });

  it('throws when bindings outnumber placeholders', () => {
    expect(() => inlineBindings('a = ?', [1, 2], marker)).to.throw(InvalidOperation);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/literals.test.ts`
Expected: FAIL - `Cannot find module '../src/literals.js'` (or TS2305 `has no exported member 'LiteralQuoter'`).

- [ ] **Step 3: Add the abstraction to `@spinajs/orm`**

Append to `packages/orm/src/quoting.ts`:

```ts
/**
 * Writes a VALUE into SQL text the way one dialect spells literals.
 *
 * Only for statements the engine stores as text and therefore cannot bind into -
 * CREATE VIEW and CREATE EVENT. Every other statement keeps binding its values.
 * No default registration, for the same reason {@link IdentifierQuoter} has none.
 */
@NewInstance()
export abstract class LiteralQuoter {
  public abstract quote(value: unknown): string;
}
```

Run (in `packages/orm`): `npm run compile`
Expected: exits 0.

- [ ] **Step 4: Implement the shared quoter and `inlineBindings`**

Create `packages/orm-sql/src/literals.ts`:

```ts
import { Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DatetimeValueConverter, LiteralQuoter } from '@spinajs/orm';
import { DateTime } from 'luxon';

/**
 * The plain ANSI spelling: single quotes with embedded quotes doubled, 1 / 0 for booleans.
 * Valid sqlite as it is; the other drivers override `quoteString` / `quoteBoolean`.
 */
@NewInstance()
@Inject(Container)
export class SqlLiteralQuoter extends LiteralQuoter {
  constructor(protected container: IContainer) {
    super();
  }

  public quote(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    switch (typeof value) {
      case 'number':
        if (!Number.isFinite(value)) {
          throw new InvalidArgument(`cannot write ${value} as an SQL literal`);
        }
        return String(value);
      case 'bigint':
        return value.toString();
      case 'boolean':
        return this.quoteBoolean(value);
      case 'string':
        return this.quoteString(value);
    }

    if (value instanceof Date || DateTime.isDateTime(value)) {
      return this.quoteDate(value);
    }

    throw new InvalidArgument(`cannot write a value of type ${(value as object).constructor?.name ?? typeof value} as an SQL literal`);
  }

  protected quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  protected quoteBoolean(value: boolean): string {
    return value ? '1' : '0';
  }

  protected quoteDate(value: Date | DateTime): string {
    const converter = this.container.resolve<DatetimeValueConverter>(DatetimeValueConverter);
    return this.quoteString(String(converter.toDB(value, null as any, null as any)));
  }
}

const QUOTES = ["'", '"', '`'];

/**
 * Writes `bindings` into the `?` placeholders of `expression`.
 *
 * Placeholders inside quoted regions and comments are left alone. A backslash is NOT an
 * escape here and `[...]` is not quoting ( it is array syntax in postgres ).
 */
export function inlineBindings(expression: string, bindings: unknown[], quoter: LiteralQuoter): string {
  if (!bindings || bindings.length === 0) {
    return expression;
  }

  let out = '';
  let used = 0;
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];

    if (QUOTES.includes(ch)) {
      let end = i + 1;
      while (end < expression.length) {
        if (expression[end] === ch) {
          if (expression[end + 1] !== ch) {
            break;
          }
          end++;
        }
        end++;
      }
      out += expression.substring(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '-' && expression[i + 1] === '-') {
      const eol = expression.indexOf('\n', i);
      const end = eol === -1 ? expression.length : eol;
      out += expression.substring(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && expression[i + 1] === '*') {
      const close = expression.indexOf('*/', i + 2);
      const end = close === -1 ? expression.length : close + 2;
      out += expression.substring(i, end);
      i = end;
      continue;
    }

    if (ch === '?') {
      if (used >= bindings.length) {
        throw new InvalidOperation(`expression has more placeholders than its ${bindings.length} bindings`);
      }
      out += quoter.quote(bindings[used++]);
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  if (used !== bindings.length) {
    throw new InvalidOperation(`expression has ${used} placeholders but ${bindings.length} bindings`);
  }

  return out;
}
```

In `packages/orm-sql/src/index.ts`, next to the existing `export * from './statements.js';` line, add:

```ts
export * from './literals.js';
```

In `packages/orm-sql/test/fixture.ts`: add `LiteralQuoter` to the existing `@spinajs/orm` import list, add

```ts
import { SqlLiteralQuoter } from '../src/literals.js';
```

and, right after `this.Container.register(BacktickIdentifierQuoter).as(IdentifierQuoter);` in `FakeSqliteDriver.resolve()`:

```ts
    this.Container.register(SqlLiteralQuoter).as(LiteralQuoter);
```

- [ ] **Step 5: Run the test to verify it passes**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/literals.test.ts`
Expected: 15 passing.

- [ ] **Step 6: Compile and commit**

Run (in `packages/orm-sql`): `npm run compile` - exits 0.

```bash
git add docs/superpowers packages/orm/src/quoting.ts packages/orm-sql/src/literals.ts packages/orm-sql/src/index.ts packages/orm-sql/test/fixture.ts packages/orm-sql/test/literals.test.ts
git commit -m "feat(orm): literal quoting service for statements that cannot bind"
```

---

### Task 2: `CreateViewQueryBuilder` and the shared view compiler

**Files:**
- Modify: `packages/orm/src/interfaces.ts` (after `DropViewCompiler`, ~line 1572)
- Modify: `packages/orm/src/builders.ts` (import line 8; after `DropViewQueryBuilder`, ~line 2326; `SchemaQueryBuilder`, ~line 2876)
- Create: `packages/orm-sql/src/views.ts`
- Modify: `packages/orm-sql/src/index.ts`, `packages/orm-sql/test/fixture.ts`
- Test: `packages/orm-sql/test/view.test.ts`

**Interfaces:**
- Consumes: `LiteralQuoter`, `inlineBindings` (Task 1).
- Produces from `@spinajs/orm`: `abstract class CreateViewCompiler { abstract compile(): ICompilerOutput }`; types `ViewAlgorithm = 'UNDEFINED' | 'MERGE' | 'TEMPTABLE'`, `ViewSecurity = 'DEFINER' | 'INVOKER'`, `ViewCheckOption = 'CASCADED' | 'LOCAL'`; `class CreateViewQueryBuilder extends QueryBuilder` with public state `Replace: boolean`, `IfNotExists: boolean`, `Temporary: boolean`, `Columns: string[]`, `Algorithm?: ViewAlgorithm`, `Security?: ViewSecurity`, `CheckOption?: ViewCheckOption | true`, `Body?: SelectQueryBuilder | RawQuery` and fluent `orReplace()`, `ifNotExists()`, `temporary()`, `columns(names)`, `algorithm(a)`, `security(s)`, `checkOption(o?)`, `as(body)`; `SchemaQueryBuilder.createView(name: string, callback: (view: CreateViewQueryBuilder) => void): CreateViewQueryBuilder`; module-private helper `assertOneOf(value, allowed, clause)` in `builders.ts` (reused by Task 7).
- Produces from `@spinajs/orm-sql`: `class SqlCreateViewQueryCompiler extends CreateViewCompiler` with `constructor(container: Container, builder: CreateViewQueryBuilder)`, `protected Engine: string`, `protected unsupported(clause: string): never`, `protected checkOptionSql(): string`, and overridable hooks `_replace()`, `_temporary()`, `_prefixOptions()`, `_ifNotExists()`, `_name()`, `_columns()`, `_withOptions()`, `_body()`, `_checkOption()`, all returning `string`.

- [ ] **Step 1: Write the failing test**

Create `packages/orm-sql/test/view.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, Orm, QueryContext, RawQuery, SchemaQueryBuilder, SelectQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

function schqb() {
  return connection().Container.resolve(SchemaQueryBuilder, [connection()]);
}

describe('create view, shared compiler', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('returns a schema builder', () => {
    const builder = schqb().createView('v', (view) => view.as(new RawQuery('SELECT 1')));

    expect(builder).to.be.instanceOf(CreateViewQueryBuilder);
    expect(builder.QueryContext).to.eq(QueryContext.Schema);
  });

  it('compiles the portable core', () => {
    const result = schqb()
      .createView('active_users', (view) => view.as(new RawQuery('SELECT * FROM users')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `active_users` AS SELECT * FROM users');
    expect(result.bindings).to.deep.eq([]);
  });

  it('qualifies the name with the database', () => {
    const result = schqb()
      .createView('active_users', (view) => view.database('app').as(new RawQuery('SELECT 1')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `app`.`active_users` AS SELECT 1');
  });

  it('writes an explicit column list', () => {
    const result = schqb()
      .createView('v', (view) => view.columns(['id', 'name']).as(new RawQuery('SELECT 1, 2')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `v` (`id`,`name`) AS SELECT 1, 2');
  });

  it('builds the body from a select callback and inlines its bindings', () => {
    const result = schqb()
      .createView('v', (view) => view.as((select) => select.from('users').where('isDeleted', 0).where('role', `adm'in`)))
      .toDB();

    expect(result.expression).to.eq("CREATE VIEW `v` AS SELECT * FROM `users` WHERE `isDeleted` = 0 AND `role` = 'adm''in'");
    expect(result.bindings).to.deep.eq([]);
  });

  it('takes a ready select builder', () => {
    const select = new SelectQueryBuilder(connection().Container, connection());
    select.from('users').where('age', '>', 18);

    const result = schqb().createView('v', (view) => view.as(select)).toDB();

    expect(result.expression).to.eq('CREATE VIEW `v` AS SELECT * FROM `users` WHERE `age` > 18');
  });

  it('inlines the bindings of a raw body', () => {
    const result = schqb()
      .createView('v', (view) => view.as(new RawQuery('SELECT * FROM users WHERE age > ? AND role = ?', [18, 'admin'])))
      .toDB();

    expect(result.expression).to.eq("CREATE VIEW `v` AS SELECT * FROM users WHERE age > 18 AND role = 'admin'");
  });

  it('refuses a view without a body', () => {
    expect(() => schqb().createView('v', () => undefined).toDB()).to.throw(InvalidOperation, /no body/);
  });

  const optional: [string, (view: CreateViewQueryBuilder) => unknown][] = [
    ['OR REPLACE', (view) => view.orReplace()],
    ['IF NOT EXISTS', (view) => view.ifNotExists()],
    ['TEMPORARY', (view) => view.temporary()],
    ['ALGORITHM', (view) => view.algorithm('MERGE')],
    ['SQL SECURITY', (view) => view.security('INVOKER')],
    ['CHECK OPTION', (view) => view.checkOption()],
  ];

  for (const [clause, apply] of optional) {
    it(`throws for ${clause}, which only a driver can enable`, () => {
      const builder = schqb().createView('v', (view) => {
        apply(view);
        view.as(new RawQuery('SELECT 1'));
      });

      expect(() => builder.toDB()).to.throw(MethodNotImplemented, clause);
    });
  }

  it('refuses option values outside their allow-list', () => {
    expect(() => schqb().createView('v', (view) => view.algorithm('MERGE; DROP TABLE x' as any))).to.throw(InvalidArgument);
    expect(() => schqb().createView('v', (view) => view.security('ROOT' as any))).to.throw(InvalidArgument);
    expect(() => schqb().createView('v', (view) => view.checkOption('GLOBAL' as any))).to.throw(InvalidArgument);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/view.test.ts`
Expected: FAIL - TS2305 `Module '"@spinajs/orm"' has no exported member 'CreateViewQueryBuilder'`.

- [ ] **Step 3: Add the abstraction and the builder to `@spinajs/orm`**

In `packages/orm/src/interfaces.ts`, right after the `DropViewCompiler` class:

```ts
@NewInstance()
export abstract class CreateViewCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}
```

In `packages/orm/src/builders.ts`, add `CreateViewCompiler` to the `./interfaces.js` import (line 8). Right after the `DropViewQueryBuilder` class add:

```ts
export type ViewAlgorithm = 'UNDEFINED' | 'MERGE' | 'TEMPTABLE';
export type ViewSecurity = 'DEFINER' | 'INVOKER';
export type ViewCheckOption = 'CASCADED' | 'LOCAL';

const VIEW_ALGORITHMS: readonly string[] = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];
const VIEW_SECURITY: readonly string[] = ['DEFINER', 'INVOKER'];
const VIEW_CHECK_OPTIONS: readonly string[] = ['CASCADED', 'LOCAL'];

// These reach the SQL text unquoted, so a value outside the list is refused, not interpolated.
function assertOneOf<T extends string>(value: T, allowed: readonly string[], clause: string): T {
  if (!allowed.includes(value)) {
    throw new InvalidArgument(`invalid ${clause} "${value}", expected one of: ${allowed.join(', ')}`);
  }

  return value;
}

/**
 * CREATE VIEW. Which optional clauses exist is the dialect's business: a driver's compiler
 * throws MethodNotImplemented for a clause its engine does not have.
 */
@NewInstance()
export class CreateViewQueryBuilder extends QueryBuilder {
  public Replace = false;
  public IfNotExists = false;
  public Temporary = false;
  public Columns: string[] = [];
  public Algorithm?: ViewAlgorithm;
  public Security?: ViewSecurity;

  /** `true` is the plain `WITH CHECK OPTION` */
  public CheckOption?: ViewCheckOption | true;

  public Body?: SelectQueryBuilder | RawQuery;

  constructor(container: Container, driver: OrmDriver, name: string, database?: string) {
    super(container, driver, undefined);

    this.setTable(name);

    if (database) {
      this.database(database);
    }

    this.QueryContext = QueryContext.Schema;
  }

  public orReplace() {
    this.Replace = true;
    return this;
  }

  public ifNotExists() {
    this.IfNotExists = true;
    return this;
  }

  public temporary() {
    this.Temporary = true;
    return this;
  }

  public columns(names: string[]) {
    this.Columns = names;
    return this;
  }

  public algorithm(algorithm: ViewAlgorithm) {
    this.Algorithm = assertOneOf(algorithm, VIEW_ALGORITHMS, 'view algorithm');
    return this;
  }

  public security(security: ViewSecurity) {
    this.Security = assertOneOf(security, VIEW_SECURITY, 'view security');
    return this;
  }

  public checkOption(option?: ViewCheckOption) {
    this.CheckOption = option ? assertOneOf(option, VIEW_CHECK_OPTIONS, 'view check option') : true;
    return this;
  }

  /**
   * @param body - callback receiving a fresh select builder, a ready select builder, or raw SQL
   */
  public as(body: ((select: SelectQueryBuilder) => void) | SelectQueryBuilder | RawQuery) {
    if (typeof body === 'function') {
      const select = new SelectQueryBuilder(this._container, this._driver);
      body(select);
      this.Body = select;
    } else {
      this.Body = body;
    }

    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<CreateViewCompiler>(CreateViewCompiler, [this]).compile();
  }
}
```

In `SchemaQueryBuilder`, right before `dropView`:

```ts
  public createView(name: string, callback: (view: CreateViewQueryBuilder) => void) {
    const builder = new CreateViewQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }
```

Run (in `packages/orm`): `npm run compile`
Expected: exits 0.

- [ ] **Step 4: Implement the shared compiler**

Create `packages/orm-sql/src/views.ts`:

```ts
import { Autoinject, Container, Inject, NewInstance } from '@spinajs/di';
import { InvalidOperation, MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewCompiler, CreateViewQueryBuilder, ICompilerOutput, IdentifierQuoter, LiteralQuoter, RawQuery, TableAliasCompiler } from '@spinajs/orm';
import { inlineBindings } from './literals.js';

/**
 * Portable core only. Every optional clause throws here and a driver overrides the hook of
 * each clause its engine has, so a clause nobody ported fails instead of reaching the engine
 * as another dialect's SQL.
 */
@NewInstance()
@Inject(Container)
export class SqlCreateViewQueryCompiler extends CreateViewCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  @Autoinject(LiteralQuoter)
  public Literals: LiteralQuoter;

  protected Engine = 'this database engine';

  constructor(protected container: Container, protected builder: CreateViewQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const parts = ['CREATE', this._replace(), this._temporary(), this._prefixOptions(), 'VIEW', this._ifNotExists(), this._name(), this._columns(), this._withOptions(), 'AS', this._body(), this._checkOption()];

    return {
      bindings: [],
      expression: parts.filter((part) => part !== '').join(' '),
    };
  }

  protected unsupported(clause: string): never {
    throw new MethodNotImplemented(`${this.Engine} does not support ${clause} on CREATE VIEW`);
  }

  protected _replace(): string {
    return this.builder.Replace ? this.unsupported('OR REPLACE') : '';
  }

  protected _temporary(): string {
    return this.builder.Temporary ? this.unsupported('TEMPORARY') : '';
  }

  /** Clauses between CREATE and VIEW */
  protected _prefixOptions(): string {
    if (this.builder.Algorithm) {
      this.unsupported('ALGORITHM');
    }

    if (this.builder.Security) {
      this.unsupported('SQL SECURITY');
    }

    return '';
  }

  protected _ifNotExists(): string {
    return this.builder.IfNotExists ? this.unsupported('IF NOT EXISTS') : '';
  }

  protected _name(): string {
    return this.container.resolve(TableAliasCompiler).compile(this.builder);
  }

  protected _columns(): string {
    return this.builder.Columns.length === 0 ? '' : `(${this.builder.Columns.map((column) => this.Quoter.quote(column)).join(',')})`;
  }

  /** Clauses between the column list and AS */
  protected _withOptions(): string {
    return '';
  }

  protected _body(): string {
    const body = this.builder.Body;

    if (!body) {
      throw new InvalidOperation(`view ${this.builder.Table} has no body, call as() first`);
    }

    if (body instanceof RawQuery) {
      return inlineBindings(body.Query, body.Bindings, this.Literals);
    }

    const compiled = body.toDB();
    return inlineBindings(compiled.expression, compiled.bindings, this.Literals);
  }

  protected _checkOption(): string {
    return this.builder.CheckOption ? this.unsupported('CHECK OPTION') : '';
  }

  /** The full `WITH [CASCADED | LOCAL] CHECK OPTION`, for the dialects that have every form. */
  protected checkOptionSql(): string {
    const option = this.builder.CheckOption;

    if (!option) {
      return '';
    }

    return option === true ? 'WITH CHECK OPTION' : `WITH ${option} CHECK OPTION`;
  }
}
```

In `packages/orm-sql/src/index.ts` add next to the other `export *` lines:

```ts
export * from './views.js';
```

In `packages/orm-sql/test/fixture.ts`: add `CreateViewCompiler` to the `@spinajs/orm` import list, add `import { SqlCreateViewQueryCompiler } from '../src/views.js';`, and register after the `SqlLiteralQuoter` line:

```ts
    this.Container.register(SqlCreateViewQueryCompiler).as(CreateViewCompiler);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/view.test.ts test/literals.test.ts`
Expected: 30 passing (15 + 15).

- [ ] **Step 6: Compile and commit**

Run (in `packages/orm-sql`): `npm run compile` - exits 0.

```bash
git add packages/orm/src/interfaces.ts packages/orm/src/builders.ts packages/orm-sql/src/views.ts packages/orm-sql/src/index.ts packages/orm-sql/test/fixture.ts packages/orm-sql/test/view.test.ts
git commit -m "feat(orm): createView builder with a portable shared compiler"
```

---

### Task 3: MySQL views

**Files:**
- Modify: `packages/orm-mysql/src/compilers.ts`, `packages/orm-mysql/src/statements.ts`, `packages/orm-mysql/src/index.ts` (`resolve()`, ~line 244)
- Test: `packages/orm-mysql/test/view.test.ts`

**Interfaces:**
- Consumes: `SqlCreateViewQueryCompiler`, `SqlLiteralQuoter` (`@spinajs/orm-sql`); `CreateViewCompiler`, `LiteralQuoter`, `CreateViewQueryBuilder` (`@spinajs/orm`).
- Produces: `MySqlCreateViewCompiler`, `MySqlLiteralQuoter`, registered in the mysql driver container as `CreateViewCompiler` / `LiteralQuoter` (Task 7 relies on the `LiteralQuoter` registration).

- [ ] **Step 1: Write the failing test**

Create `packages/orm-mysql/test/view.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';
import { MySqlLiteralQuoter } from '../src/statements.js';

describe('mysql views', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-view-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('campaign_view', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(MySqlLiteralQuoter);
  });

  it('compiles every clause mysql has, in mysql order', () => {
    const result = view((v) => v.database('arrow4').orReplace().algorithm('UNDEFINED').security('DEFINER').columns(['id', 'name']).checkOption('CASCADED').as(new RawQuery('SELECT id, name FROM arrow_campaign'))).toDB();

    expect(result.expression).to.eq('CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `arrow4`.`campaign_view` (`id`,`name`) AS SELECT id, name FROM arrow_campaign WITH CASCADED CHECK OPTION');
    expect(result.bindings).to.deep.eq([]);
  });

  it('compiles the plain and the local check option', () => {
    expect(view((v) => v.checkOption().as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW `campaign_view` AS SELECT 1 WITH CHECK OPTION');
    expect(view((v) => v.checkOption('LOCAL').as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW `campaign_view` AS SELECT 1 WITH LOCAL CHECK OPTION');
  });

  it('throws for the clauses mysql does not have', () => {
    expect(() => view((v) => v.ifNotExists().as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'mysql does not support IF NOT EXISTS');
    expect(() => view((v) => v.temporary().as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'mysql does not support TEMPORARY');
  });

  it('inlines select bindings with mysql escaping', () => {
    const result = view((v) => v.as((select) => select.from('users').where('isDeleted', 0).where('name', `it's`))).toDB();

    expect(result.expression).to.eq("CREATE VIEW `campaign_view` AS SELECT * FROM `users` WHERE `isDeleted` = 0 AND `name` = 'it\\'s'");
  });

  it('escapes backslashes, which mysql reads as escapes inside a literal', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote('a\\b')).to.eq("'a\\\\b'");
    expect(quoter.quote(`'; DROP TABLE x; --`)).to.eq("'\\'; DROP TABLE x; --'");
    expect(quoter.quote(true)).to.eq('1');
  });

  it('drops a view', () => {
    expect(schema().dropView('campaign_view', 'arrow4').ifExists().toDB().expression).to.eq('DROP VIEW IF EXISTS `arrow4`.`campaign_view`');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-mysql`): `npx ts-mocha -p tsconfig.json test/view.test.ts`
Expected: FAIL - TS2305 `'"../src/statements.js"' has no exported member 'MySqlLiteralQuoter'`.

- [ ] **Step 3: Implement**

Append to `packages/orm-mysql/src/statements.ts` (extend the existing imports: `Container`, `IContainer`, `Inject` from `@spinajs/di`; `SqlLiteralQuoter` from `@spinajs/orm-sql`; `import * as mysql from 'mysql2';`):

```ts
@NewInstance()
@Inject(Container)
export class MySqlLiteralQuoter extends SqlLiteralQuoter {
  constructor(container: IContainer) {
    super(container);
  }

  // mysql reads a backslash inside a literal as an escape, so doubling quotes alone is not enough
  protected quoteString(value: string): string {
    return mysql.escape(value);
  }
}
```

Append to `packages/orm-mysql/src/compilers.ts` (extend the imports: `Container`, `Inject` from `@spinajs/di`; `CreateViewQueryBuilder` from `@spinajs/orm`; `SqlCreateViewQueryCompiler` from `@spinajs/orm-sql`):

```ts
@NewInstance()
@Inject(Container)
export class MySqlCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'mysql';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR REPLACE' : '';
  }

  protected _prefixOptions(): string {
    const options: string[] = [];

    if (this.builder.Algorithm) {
      options.push(`ALGORITHM=${this.builder.Algorithm}`);
    }

    if (this.builder.Security) {
      options.push(`SQL SECURITY ${this.builder.Security}`);
    }

    return options.join(' ');
  }

  protected _checkOption(): string {
    return this.checkOptionSql();
  }
}
```

In `packages/orm-mysql/src/index.ts`: add `CreateViewCompiler, LiteralQuoter` to the `@spinajs/orm` import, `MySqlCreateViewCompiler` to the `./compilers.js` import, `MySqlLiteralQuoter` to the `./statements.js` import, and in `resolve()` after the `TableHistoryQueryCompiler` registration:

```ts
    this.Container.register(MySqlCreateViewCompiler).as(CreateViewCompiler);
    this.Container.register(MySqlLiteralQuoter).as(LiteralQuoter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (in `packages/orm-mysql`): `npx ts-mocha -p tsconfig.json test/view.test.ts test/dialect.test.ts`
Expected: all passing (7 new + the existing dialect tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orm-mysql/src packages/orm-mysql/test/view.test.ts
git commit -m "feat(orm-mysql): CREATE VIEW with algorithm, security and check option"
```

---

### Task 4: SQLite views

**Files:**
- Modify: `packages/orm-sqlite/src/compilers.ts`, `packages/orm-sqlite/src/index.ts` (`resolve()`, ~line 360)
- Test: `packages/orm-sqlite/test/view.test.ts`

**Interfaces:**
- Consumes: `SqlCreateViewQueryCompiler`, `SqlLiteralQuoter` (`@spinajs/orm-sql`).
- Produces: `SqliteCreateViewCompiler`; sqlite claims the shared `SqlLiteralQuoter` as its `LiteralQuoter`.

- [ ] **Step 1: Write the failing test**

Create `packages/orm-sqlite/test/view.test.ts`:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, Orm, QueryContext, RawQuery } from '@spinajs/orm';
import { SqlLiteralQuoter } from '@spinajs/orm-sql';

import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf } from './common.js';

describe('sqlite views', function () {
  this.timeout(25000);

  let connection: SqliteOrmDriver;

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    await DI.resolve(Configuration);
    const orm = await DI.resolve(Orm);
    connection = orm.Connections.get('sqlite') as SqliteOrmDriver;

    await connection.executeOnDb(`CREATE TABLE IF NOT EXISTS view_users (Id INTEGER PRIMARY KEY AUTOINCREMENT, Login TEXT, Role TEXT)`, [], QueryContext.Schema);
    await connection.executeOnDb(`DELETE FROM view_users`, [], QueryContext.Delete);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  const view = (build: (view: CreateViewQueryBuilder) => void) => connection.schema().createView('view_admins', build);

  it('claims the shared literal quoter', () => {
    expect(connection.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(SqlLiteralQuoter);
  });

  it('compiles the clauses sqlite has', () => {
    const result = view((v) => v.temporary().ifNotExists().columns(['Login']).as(new RawQuery('SELECT Login FROM view_users'))).toDB();

    expect(result.expression).to.eq('CREATE TEMP VIEW IF NOT EXISTS `view_admins` (`Login`) AS SELECT Login FROM view_users');
  });

  it('throws for the clauses sqlite does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.orReplace().as(raw)).toDB()).to.throw(MethodNotImplemented, 'sqlite does not support OR REPLACE');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
    expect(() => view((v) => v.security('INVOKER').as(raw)).toDB()).to.throw(MethodNotImplemented, 'SQL SECURITY');
    expect(() => view((v) => v.checkOption().as(raw)).toDB()).to.throw(MethodNotImplemented, 'CHECK OPTION');
  });

  it('creates a view whose body carries a binding, reads through it and drops it', async () => {
    await connection.executeOnDb(`INSERT INTO view_users (Login, Role) VALUES (?, ?)`, ['alice', 'admin'], QueryContext.Insert);
    await connection.executeOnDb(`INSERT INTO view_users (Login, Role) VALUES (?, ?)`, ['bob', 'user'], QueryContext.Insert);

    await view((v) => v.ifNotExists().as((select) => select.from('view_users').where('Role', 'admin')));

    const rows = (await connection.executeOnDb(`SELECT Login FROM view_admins`, [], QueryContext.Select)) as any[];
    expect(rows.map((row) => row.Login)).to.deep.eq(['alice']);

    await connection.schema().dropView('view_admins').ifExists();

    const left = (await connection.executeOnDb(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'view_admins'`, [], QueryContext.Select)) as any[];
    expect(left).to.have.lengthOf(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-sqlite`): `npx ts-mocha -p tsconfig.json test/view.test.ts`
Expected: FAIL - a DI resolve error naming `LiteralQuoter` / `CreateViewCompiler` (nothing registered yet).

- [ ] **Step 3: Implement**

Append to `packages/orm-sqlite/src/compilers.ts` (add `CreateViewQueryBuilder` to the `@spinajs/orm` import and `SqlCreateViewQueryCompiler` to the `@spinajs/orm-sql` import):

```ts
@NewInstance()
@Inject(Container)
export class SqliteCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'sqlite';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _temporary(): string {
    return this.builder.Temporary ? 'TEMP' : '';
  }

  protected _ifNotExists(): string {
    return this.builder.IfNotExists ? 'IF NOT EXISTS' : '';
  }
}
```

In `packages/orm-sqlite/src/index.ts`: add `CreateViewCompiler, LiteralQuoter` to the `@spinajs/orm` import, `SqlLiteralQuoter` to the `@spinajs/orm-sql` import, `SqliteCreateViewCompiler` to the `./compilers.js` import. In `resolve()`, after the `DropDatabaseCompiler` registration:

```ts
    this.Container.register(SqliteCreateViewCompiler).as(CreateViewCompiler);
```

and in the "Shared implementations that happen to be valid SQLite, claimed explicitly" block:

```ts
    this.Container.register(SqlLiteralQuoter).as(LiteralQuoter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (in `packages/orm-sqlite`): `npx ts-mocha -p tsconfig.json test/view.test.ts test/dialect.test.ts`
Expected: all passing (4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/orm-sqlite/src packages/orm-sqlite/test/view.test.ts
git commit -m "feat(orm-sqlite): CREATE VIEW with TEMP and IF NOT EXISTS"
```

---

### Task 5: PostgreSQL views

**Files:**
- Modify: `packages/orm-postgres/src/compilers.ts`, `packages/orm-postgres/src/statements.ts`, `packages/orm-postgres/src/index.ts` (`resolve()`, ~line 200)
- Test: `packages/orm-postgres/test/view.test.ts`

**Interfaces:**
- Consumes: `SqlCreateViewQueryCompiler`, `SqlLiteralQuoter` (`@spinajs/orm-sql`).
- Produces: `PostgresCreateViewCompiler`, `PostgresLiteralQuoter`.

- [ ] **Step 1: Write the failing test**

Create `packages/orm-postgres/test/view.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { PostgresOrmDriver } from '../src/index.js';
import { PostgresLiteralQuoter } from '../src/statements.js';

describe('postgres views', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'postgres-view-test', Driver: 'orm-driver-postgres' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('active_users', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(PostgresLiteralQuoter);
  });

  it('compiles every clause postgres has, in postgres order', () => {
    const result = view((v) => v.orReplace().temporary().columns(['id', 'name']).security('INVOKER').checkOption('LOCAL').as(new RawQuery('SELECT id, name FROM users'))).toDB();

    expect(result.expression).to.eq('CREATE OR REPLACE TEMPORARY VIEW "active_users" ("id","name") WITH (security_invoker = true) AS SELECT id, name FROM users WITH LOCAL CHECK OPTION');
    expect(result.bindings).to.deep.eq([]);
  });

  it('spells definer security as security_invoker = false', () => {
    expect(view((v) => v.security('DEFINER').as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW "active_users" WITH (security_invoker = false) AS SELECT 1');
  });

  it('throws for the clauses postgres does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.ifNotExists().as(raw)).toDB()).to.throw(MethodNotImplemented, 'postgres does not support IF NOT EXISTS');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
  });

  it('inlines select bindings with postgres literals', () => {
    const result = view((v) => v.as((select) => select.from('users').where('age', '>', 18).where('name', `it's`))).toDB();

    expect(result.expression).to.eq(`CREATE VIEW "active_users" AS SELECT * FROM "users" WHERE "age" > 18 AND "name" = 'it''s'`);
  });

  it('writes booleans as TRUE and FALSE', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote(true)).to.eq('TRUE');
    expect(quoter.quote(false)).to.eq('FALSE');
  });

  it('drops a view', () => {
    expect(schema().dropView('active_users').ifExists().toDB().expression).to.eq('DROP VIEW IF EXISTS "active_users"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-postgres`): `npx ts-mocha -p tsconfig.json test/view.test.ts`
Expected: FAIL - TS2305 `has no exported member 'PostgresLiteralQuoter'`.

- [ ] **Step 3: Implement**

Append to `packages/orm-postgres/src/statements.ts` (imports: `Container, IContainer, Inject, NewInstance` from `@spinajs/di`; `SqlLiteralQuoter` from `@spinajs/orm-sql`; `import pg from 'pg';`):

```ts
@NewInstance()
@Inject(Container)
export class PostgresLiteralQuoter extends SqlLiteralQuoter {
  constructor(container: IContainer) {
    super(container);
  }

  protected quoteString(value: string): string {
    return pg.escapeLiteral(value);
  }

  protected quoteBoolean(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
  }
}
```

If `packages/orm-postgres/src/index.ts` imports `pg` differently (check its first lines), use the same import form here.

Append to `packages/orm-postgres/src/compilers.ts` (add `CreateViewQueryBuilder` to the `@spinajs/orm` import, `SqlCreateViewQueryCompiler` to the `@spinajs/orm-sql` import):

```ts
@NewInstance()
@Inject(Container)
export class PostgresCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'postgres';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR REPLACE' : '';
  }

  protected _temporary(): string {
    return this.builder.Temporary ? 'TEMPORARY' : '';
  }

  protected _prefixOptions(): string {
    return this.builder.Algorithm ? this.unsupported('ALGORITHM') : '';
  }

  // security_invoker exists since PostgreSQL 15
  protected _withOptions(): string {
    return this.builder.Security ? `WITH (security_invoker = ${this.builder.Security === 'INVOKER'})` : '';
  }

  protected _checkOption(): string {
    return this.checkOptionSql();
  }
}
```

In `packages/orm-postgres/src/index.ts`: add `CreateViewCompiler, LiteralQuoter` to the `@spinajs/orm` import, `PostgresCreateViewCompiler` to the compilers import, `PostgresLiteralQuoter` to the statements import. In `resolve()` after the `PostgresTableAliasCompiler` registration:

```ts
    this.Container.register(PostgresCreateViewCompiler).as(CreateViewCompiler);
    this.Container.register(PostgresLiteralQuoter).as(LiteralQuoter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (in `packages/orm-postgres`): `npx ts-mocha -p tsconfig.json test/view.test.ts test/dialect.test.ts test/compile.test.ts`
Expected: all passing (7 new).

- [ ] **Step 5: Commit**

```bash
git add packages/orm-postgres/src packages/orm-postgres/test/view.test.ts
git commit -m "feat(orm-postgres): CREATE VIEW with security_invoker and check option"
```

---

### Task 6: MSSQL views

**Files:**
- Modify: `packages/orm-mssql/src/compilers.ts`, `packages/orm-mssql/src/statements.ts`, `packages/orm-mssql/src/index.ts` (`resolve()`, ~line 175)
- Test: `packages/orm-mssql/test/view.test.ts`

**Interfaces:**
- Consumes: `SqlCreateViewQueryCompiler`, `SqlLiteralQuoter` (`@spinajs/orm-sql`).
- Produces: `MsSqlCreateViewCompiler`, `MsSqlLiteralQuoter`.

Note for the implementer: `MsSqlTableAliasCompiler` quotes table names with BACKTICKS and the driver strips every backtick in `executeOnDb`. The test therefore strips them too before asserting, exactly as the driver does.

- [ ] **Step 1: Write the failing test**

Create `packages/orm-mssql/test/view.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, ICompilerOutput, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlLiteralQuoter } from '../src/statements.js';

/** What actually reaches SQL Server: the driver strips backticks in executeOnDb. */
function sent(output: ICompilerOutput) {
  return (output.expression as string).replaceAll('`', '');
}

describe('mssql views', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-view-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('active_users', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(MsSqlLiteralQuoter);
  });

  it('spells OR REPLACE as CREATE OR ALTER and has the plain check option', () => {
    const result = view((v) => v.orReplace().columns(['id', 'name']).checkOption().as(new RawQuery('SELECT id, name FROM users')));

    expect(sent(result.toDB())).to.eq('CREATE OR ALTER VIEW active_users ([id],[name]) AS SELECT id, name FROM users WITH CHECK OPTION');
  });

  it('throws for the clauses mssql does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.ifNotExists().as(raw)).toDB()).to.throw(MethodNotImplemented, 'mssql does not support IF NOT EXISTS');
    expect(() => view((v) => v.temporary().as(raw)).toDB()).to.throw(MethodNotImplemented, 'TEMPORARY');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
    expect(() => view((v) => v.security('INVOKER').as(raw)).toDB()).to.throw(MethodNotImplemented, 'SQL SECURITY');
    expect(() => view((v) => v.checkOption('CASCADED').as(raw)).toDB()).to.throw(MethodNotImplemented, 'WITH CASCADED CHECK OPTION');
  });

  it('refuses a database prefix, which T-SQL forbids on CREATE VIEW', () => {
    expect(() => view((v) => v.database('other').as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'database prefix');
  });

  it('writes unicode string literals and 1 / 0 booleans', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote(`it's`)).to.eq(`N'it''s'`);
    expect(quoter.quote(true)).to.eq('1');
  });

  it('inlines raw body bindings', () => {
    const result = view((v) => v.as(new RawQuery('SELECT * FROM users WHERE role = ? AND age > ?', ['admin', 18])));

    expect(sent(result.toDB())).to.eq(`CREATE VIEW active_users AS SELECT * FROM users WHERE role = N'admin' AND age > 18`);
  });

  it('drops a view', () => {
    expect(sent(schema().dropView('active_users').ifExists().toDB())).to.eq('DROP VIEW IF EXISTS active_users');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `packages/orm-mssql`): `npx ts-mocha -p tsconfig.json test/view.test.ts`
Expected: FAIL - TS2305 `has no exported member 'MsSqlLiteralQuoter'`.

- [ ] **Step 3: Implement**

Append to `packages/orm-mssql/src/statements.ts` (imports: `Container, IContainer, Inject` from `@spinajs/di`; `SqlLiteralQuoter` from `@spinajs/orm-sql`):

```ts
@NewInstance()
@Inject(Container)
export class MsSqlLiteralQuoter extends SqlLiteralQuoter {
  constructor(container: IContainer) {
    super(container);
  }

  // N'' keeps non-latin text intact whatever the database collation is
  protected quoteString(value: string): string {
    return `N'${value.replace(/'/g, "''")}'`;
  }
}
```

Append to `packages/orm-mssql/src/compilers.ts` (add `Container` to the `@spinajs/di` import, `MethodNotImplemented` to the `@spinajs/exceptions` import, `CreateViewQueryBuilder` to the `@spinajs/orm` import, `SqlCreateViewQueryCompiler` to the `@spinajs/orm-sql` import):

```ts
@NewInstance()
@Inject(Container)
export class MsSqlCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'mssql';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR ALTER' : '';
  }

  protected _name(): string {
    if (this.builder.Database) {
      throw new MethodNotImplemented('mssql does not allow a database prefix on CREATE VIEW, connect to that database instead');
    }

    return super._name();
  }

  protected _checkOption(): string {
    const option = this.builder.CheckOption;

    if (!option) {
      return '';
    }

    return option === true ? 'WITH CHECK OPTION' : this.unsupported(`WITH ${option} CHECK OPTION`);
  }
}
```

In `packages/orm-mssql/src/index.ts`: add `CreateViewCompiler, LiteralQuoter` to the `@spinajs/orm` import, `MsSqlCreateViewCompiler` to the compilers import, `MsSqlLiteralQuoter` to the statements import. In `resolve()` after the `DropDatabaseCompiler` registration:

```ts
    this.Container.register(MsSqlCreateViewCompiler).as(CreateViewCompiler);
    this.Container.register(MsSqlLiteralQuoter).as(LiteralQuoter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (in `packages/orm-mssql`): `npx ts-mocha -p tsconfig.json test/view.test.ts test/dialect.test.ts`
Expected: all passing (7 new).

- [ ] **Step 5: Commit**

```bash
git add packages/orm-mssql/src packages/orm-mssql/test/view.test.ts
git commit -m "feat(orm-mssql): CREATE OR ALTER VIEW"
```

---

### Task 7: Rework the event builder and its MySQL compiler

**Files:**
- Modify: `packages/orm/src/interfaces.ts` (`EventQueryCompiler`, `DropEventQueryCompiler`, ~line 1545)
- Modify: `packages/orm/src/builders.ts` (`EventIntervalDesc` ... `ScheduleQueryBuilder`, ~lines 2717-2846; `SchemaQueryBuilder.event`, ~line 2918)
- Modify: `packages/orm-sql/src/compilers.ts` (`SqlEventQueryCompiler`, `SqlDropEventQueryCompiler`, ~lines 1329-1424; import line 6)
- Test: `packages/orm-sql/test/event.test.ts`, `packages/orm-mysql/test/event.test.ts`

**Interfaces:**
- Consumes: `assertOneOf` (Task 2, same file), `LiteralQuoter` + `inlineBindings` (Task 1), the mysql `LiteralQuoter` registration (Task 3).
- Produces from `@spinajs/orm`: `type EventIntervalUnit = 'YEAR' | 'QUARTER' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND'`; `interface IEventInterval { Value: number; Unit: EventIntervalUnit }`; `EventQueryBuilder` with state `Every?`, `FromNow?: IEventInterval`, `At?`, `Starts?`, `Ends?: DateTime`, `Preserve: boolean`, `Enabled: boolean`, `IfNotExists: boolean`, `Comment?: string`, `Actions: (RawQuery | QueryBuilder)[]` and fluent `every(value, unit)`, `at(dateTime)`, `fromNow(value, unit)`, `starts(dt)`, `ends(dt)`, `preserve()`, `disabled()`, `ifNotExists()`, `comment(text)`, `do(sql)`; `DropEventQueryBuilder` with `Exists: boolean`, `ifExists()`; `SchemaQueryBuilder.createEvent(name, callback)`; `EventQueryCompiler.compile(): ICompilerOutput`, `DropEventQueryCompiler.compile(): ICompilerOutput`. `EventIntervalDesc`, `ScheduleQueryBuilder`, `SchemaQueryBuilder.event()` and the `Name` property are removed.

- [ ] **Step 1: Write the failing tests**

Create `packages/orm-sql/test/event.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DeleteQueryBuilder, EventQueryBuilder, Orm, QueryContext, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

function schqb() {
  return connection().Container.resolve(SchemaQueryBuilder, [connection()]);
}

function dqb() {
  return connection().Container.resolve(DeleteQueryBuilder, [connection()]);
}

describe('database events', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const purge = new RawQuery('DELETE FROM sessions');
  const event = (build: (event: EventQueryBuilder) => void) => schqb().createEvent('purge', build);

  it('returns a chainable schema builder', () => {
    const builder = event((e) => e.every(1, 'HOUR').do(purge));

    expect(builder).to.be.instanceOf(EventQueryBuilder);
    expect(builder.QueryContext).to.eq(QueryContext.Schema);
  });

  it('compiles a recurring event with explicit defaults', () => {
    const result = event((e) => e.every(5, 'MINUTE').do(purge)).toDB();

    expect(result.expression).to.eq(['CREATE EVENT `purge`', 'ON SCHEDULE EVERY 5 MINUTE', 'ON COMPLETION NOT PRESERVE', 'ENABLE', 'DO DELETE FROM sessions'].join('\n'));
    expect(result.bindings).to.deep.eq([]);
  });

  it('compiles every clause', () => {
    const result = event((e) =>
      e
        .database('app')
        .ifNotExists()
        .every(1, 'WEEK')
        .starts(DateTime.fromSQL('2026-03-13 23:00:00'))
        .ends(DateTime.fromSQL('2027-03-13 23:00:00'))
        .preserve()
        .disabled()
        .comment(`friday's purge`)
        .do(purge),
    ).toDB();

    expect(result.expression).to.eq(
      ['CREATE EVENT IF NOT EXISTS `app`.`purge`', "ON SCHEDULE EVERY 1 WEEK STARTS '2026-03-13 23:00:00.000' ENDS '2027-03-13 23:00:00.000'", 'ON COMPLETION PRESERVE', 'DISABLE', "COMMENT 'friday''s purge'", 'DO DELETE FROM sessions'].join('\n'),
    );
  });

  it('compiles a one shot event at a point in time', () => {
    const result = event((e) => e.at(DateTime.fromSQL('2026-01-01 00:00:00')).do(purge)).toDB();

    expect(result.expression).to.contain("ON SCHEDULE AT '2026-01-01 00:00:00.000'\n");
  });

  it('compiles a one shot event relative to now', () => {
    const result = event((e) => e.fromNow(1, 'DAY').do(purge)).toDB();

    expect(result.expression).to.contain('ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY\n');
  });

  it('emits a single builder action as it is, with its bindings inlined', () => {
    const result = event((e) => e.every(1, 'DAY').do(dqb().from('sessions').where('CreatedAt', '<', '2026-01-01'))).toDB();

    expect(result.expression).to.match(/DO DELETE FROM `sessions` WHERE `CreatedAt` < '2026-01-01'$/);
  });

  it('wraps several actions in BEGIN ... END, one statement per line', () => {
    const result = event((e) => e.every(1, 'DAY').do([new RawQuery('TRUNCATE TABLE a;'), new RawQuery('DELETE FROM b WHERE id > ?', [10])])).toDB();

    expect(result.expression).to.match(/DO BEGIN\nTRUNCATE TABLE a;\nDELETE FROM b WHERE id > 10;\nEND$/);
  });

  it('leaves a raw body that brings its own block untouched', () => {
    const block = 'BEGIN\n  UPDATE t SET a = 1; -- note\n  UPDATE t SET b = 2;\nEND';
    const result = event((e) => e.every(1, 'DAY').do(new RawQuery(block))).toDB();

    expect(result.expression.endsWith(`DO ${block}`)).to.eq(true);
  });

  it('refuses a second schedule', () => {
    expect(() => event((e) => e.every(1, 'DAY').at(DateTime.now()))).to.throw(InvalidOperation, /mutually exclusive/);
    expect(() => event((e) => e.fromNow(1, 'DAY').every(1, 'DAY'))).to.throw(InvalidOperation, /mutually exclusive/);
  });

  it('refuses a bad interval', () => {
    expect(() => event((e) => e.every(0, 'DAY'))).to.throw(InvalidArgument);
    expect(() => event((e) => e.every(1.5, 'DAY'))).to.throw(InvalidArgument);
    expect(() => event((e) => e.every(1, 'FORTNIGHT' as any))).to.throw(InvalidArgument);
  });

  it('refuses to compile without a schedule, without a body, or with starts on a one shot event', () => {
    expect(() => event((e) => e.do(purge)).toDB()).to.throw(InvalidOperation, /no schedule/);
    expect(() => event((e) => e.every(1, 'DAY')).toDB()).to.throw(InvalidOperation, /no body/);
    expect(() => event((e) => e.fromNow(1, 'DAY').starts(DateTime.now()).do(purge)).toDB()).to.throw(InvalidOperation, /only valid with every/);
  });

  it('drops an event, with IF EXISTS only when asked', () => {
    expect(schqb().dropEvent('purge').toDB().expression).to.eq('DROP EVENT `purge`');
    expect(schqb().dropEvent('purge').ifExists().toDB().expression).to.eq('DROP EVENT IF EXISTS `purge`');
  });
});
```

Create `packages/orm-mysql/test/event.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql events', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-event-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);

  it('reports events as supported and compiles them', () => {
    expect(driver.supportedFeatures().events).to.eq(true);

    const result = schema()
      .createEvent('cleanup_spine_jobs', (event) => event.every(3, 'MINUTE').comment(`it's a cleanup`).do(new RawQuery('DELETE FROM rtb.spine_jobs WHERE created_at < NOW() - INTERVAL 3 DAY')))
      .toDB();

    expect(result.expression).to.eq(['CREATE EVENT `cleanup_spine_jobs`', 'ON SCHEDULE EVERY 3 MINUTE', 'ON COMPLETION NOT PRESERVE', 'ENABLE', "COMMENT 'it\\'s a cleanup'", 'DO DELETE FROM rtb.spine_jobs WHERE created_at < NOW() - INTERVAL 3 DAY'].join('\n'));
  });

  it('drops an event', () => {
    expect(schema().dropEvent('cleanup_spine_jobs').ifExists().toDB().expression).to.eq('DROP EVENT IF EXISTS `cleanup_spine_jobs`');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/event.test.ts`
Expected: FAIL - TS2339 `Property 'createEvent' does not exist on type 'SchemaQueryBuilder'`.

- [ ] **Step 3: Rework the builders in `@spinajs/orm`**

In `packages/orm/src/interfaces.ts` change both abstractions to a single output:

```ts
@NewInstance()
export abstract class EventQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class DropEventQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}
```

In `packages/orm/src/builders.ts` replace everything from `export class EventIntervalDesc {` through the end of the `ScheduleQueryBuilder` class (including its doc comment) with:

```ts
export type EventIntervalUnit = 'YEAR' | 'QUARTER' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND';

const EVENT_INTERVAL_UNITS: readonly string[] = ['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];

export interface IEventInterval {
  Value: number;
  Unit: EventIntervalUnit;
}

function eventInterval(value: number, unit: EventIntervalUnit): IEventInterval {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgument(`event interval must be a positive integer, got ${value}`);
  }

  return { Value: value, Unit: assertOneOf(unit, EVENT_INTERVAL_UNITS, 'event interval unit') };
}

/**
 * A job scheduled inside the database engine. Engines without native events throw
 * MethodNotImplemented at compile time - check `supportedFeatures().events` first.
 */
@NewInstance()
@Inject(Container)
export class EventQueryBuilder extends QueryBuilder {
  public Every?: IEventInterval;
  public FromNow?: IEventInterval;
  public At?: DateTime;
  public Starts?: DateTime;
  public Ends?: DateTime;
  public Preserve = false;
  public Enabled = true;
  public IfNotExists = false;
  public Comment?: string;
  public Actions: (RawQuery | QueryBuilder)[] = [];

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver);

    this.setTable(name);
    this.QueryContext = QueryContext.Schema;
  }

  /** Repeat with the given interval */
  public every(value: number, unit: EventIntervalUnit) {
    this.assertNoSchedule();
    this.Every = eventInterval(value, unit);
    return this;
  }

  /** Run once at a point in time */
  public at(dateTime: DateTime) {
    this.assertNoSchedule();
    this.At = dateTime;
    return this;
  }

  /** Run once, the given interval from now */
  public fromNow(value: number, unit: EventIntervalUnit) {
    this.assertNoSchedule();
    this.FromNow = eventInterval(value, unit);
    return this;
  }

  public starts(dateTime: DateTime) {
    this.Starts = dateTime;
    return this;
  }

  public ends(dateTime: DateTime) {
    this.Ends = dateTime;
    return this;
  }

  /** Keep the event after its last run ( ON COMPLETION PRESERVE ) */
  public preserve() {
    this.Preserve = true;
    return this;
  }

  public disabled() {
    this.Enabled = false;
    return this;
  }

  public ifNotExists() {
    this.IfNotExists = true;
    return this;
  }

  public comment(comment: string) {
    this.Comment = comment;
    return this;
  }

  /**
   * One action is emitted as given - a statement, or raw SQL carrying its own BEGIN ... END.
   * Several actions are wrapped in BEGIN ... END.
   */
  public do(sql: RawQuery | QueryBuilder | (RawQuery | QueryBuilder)[]) {
    this.Actions = Array.isArray(sql) ? sql : [sql];
    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<EventQueryCompiler>(EventQueryCompiler, [this]).compile();
  }

  private assertNoSchedule() {
    if (this.Every || this.At || this.FromNow) {
      throw new InvalidOperation(`event ${this.Table} already has a schedule, every(), at() and fromNow() are mutually exclusive`);
    }
  }
}

@NewInstance()
@Inject(Container)
export class DropEventQueryBuilder extends QueryBuilder {
  public Exists = false;

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver);

    this.setTable(name);
    this.QueryContext = QueryContext.Schema;
  }

  public ifExists() {
    this.Exists = true;
    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropEventQueryCompiler>(DropEventQueryCompiler, [this]).compile();
  }
}
```

In `SchemaQueryBuilder` replace the `event(name)` method with:

```ts
  public createEvent(name: string, callback: (event: EventQueryBuilder) => void) {
    const builder = new EventQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }
```

(`dropEvent` stays as it is.) If `RawQueryStatement` is no longer referenced in `builders.ts` after this, remove it from the `./statements.js` import - `noUnusedLocals` is on.

Run (in `packages/orm`): `npm run compile`
Expected: exits 0.

- [ ] **Step 4: Rewrite the compilers in `@spinajs/orm-sql`**

In `packages/orm-sql/src/compilers.ts`: in the `@spinajs/orm` import (line 6) remove `EventIntervalDesc`, and make sure `EventQueryCompiler`, `DropEventQueryCompiler`, `EventQueryBuilder`, `DropEventQueryBuilder`, `LiteralQuoter`, `RawQuery`, `QueryBuilder`, `TableAliasCompiler` are present. Add `import { inlineBindings } from './literals.js';`. Replace the `SqlEventQueryCompiler` and `SqlDropEventQueryCompiler` classes with:

```ts
@NewInstance()
@Inject(Container)
export class SqlEventQueryCompiler extends EventQueryCompiler {
  @Autoinject(LiteralQuoter)
  public Literals: LiteralQuoter;

  constructor(protected container: Container, protected builder: EventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const builder = this.builder;
    const lines = [
      `CREATE EVENT${builder.IfNotExists ? ' IF NOT EXISTS' : ''} ${this.container.resolve(TableAliasCompiler).compile(builder)}`,
      `ON SCHEDULE ${this._schedule()}`,
      `ON COMPLETION ${builder.Preserve ? 'PRESERVE' : 'NOT PRESERVE'}`,
      builder.Enabled ? 'ENABLE' : 'DISABLE',
    ];

    if (builder.Comment) {
      lines.push(`COMMENT ${this.Literals.quote(builder.Comment)}`);
    }

    lines.push(`DO ${this._body()}`);

    return {
      bindings: [],
      expression: lines.join('\n'),
    };
  }

  protected _schedule(): string {
    const builder = this.builder;

    if ((builder.Starts || builder.Ends) && !builder.Every) {
      throw new InvalidOperation(`event ${builder.Table}: starts() and ends() are only valid with every()`);
    }

    if (builder.Every) {
      const starts = builder.Starts ? ` STARTS ${this.Literals.quote(builder.Starts)}` : '';
      const ends = builder.Ends ? ` ENDS ${this.Literals.quote(builder.Ends)}` : '';

      return `EVERY ${builder.Every.Value} ${builder.Every.Unit}${starts}${ends}`;
    }

    if (builder.At) {
      return `AT ${this.Literals.quote(builder.At)}`;
    }

    if (builder.FromNow) {
      return `AT CURRENT_TIMESTAMP + INTERVAL ${builder.FromNow.Value} ${builder.FromNow.Unit}`;
    }

    throw new InvalidOperation(`event ${builder.Table} has no schedule, call every(), at() or fromNow()`);
  }

  protected _body(): string {
    const statements = this.builder.Actions.flatMap((action) => this._statements(action));

    if (statements.length === 0) {
      throw new InvalidOperation(`event ${this.builder.Table} has no body, call do() first`);
    }

    if (statements.length === 1) {
      return statements[0];
    }

    const terminated = statements.map((statement) => {
      const text = statement.trimEnd();
      return text.endsWith(';') ? text : `${text};`;
    });

    return ['BEGIN', ...terminated, 'END'].join('\n');
  }

  protected _statements(action: RawQuery | QueryBuilder): string[] {
    if (action instanceof RawQuery) {
      return [inlineBindings(action.Query, action.Bindings, this.Literals)];
    }

    const compiled = action.toDB();
    return (Array.isArray(compiled) ? compiled : [compiled]).map((output) => inlineBindings(output.expression, output.bindings, this.Literals));
  }
}

@NewInstance()
@Inject(Container)
export class SqlDropEventQueryCompiler extends DropEventQueryCompiler {
  constructor(protected container: Container, protected builder: DropEventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const exists = this.builder.Exists ? ' IF EXISTS' : '';

    return {
      bindings: [],
      expression: `DROP EVENT${exists} ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`,
    };
  }
}
```

If `DateTime` (luxon) is no longer used in `compilers.ts` after removing the old `toFormat` call, remove its import.

- [ ] **Step 5: Run the tests to verify they pass**

Run (in `packages/orm-sql`): `npx ts-mocha -p tsconfig.json test/event.test.ts` - Expected: 12 passing.
Run (in `packages/orm-sql`): `npm run compile` - exits 0.
Run (in `packages/orm-mysql`): `npx ts-mocha -p tsconfig.json test/event.test.ts test/dialect.test.ts` - Expected: all passing (2 new).
Run (in `packages/orm-sql`): `npm test` - Expected: the only failures, if any, also fail on a clean `master`. To compare, run the same command in `C:\Users\grzch\SourceCodes\Spinajs\main\packages\orm-sql` (read-only for this work - run tests there, change nothing).

- [ ] **Step 6: Commit**

```bash
git add packages/orm/src packages/orm-sql/src/compilers.ts packages/orm-sql/test/event.test.ts packages/orm-mysql/test/event.test.ts
git commit -m "feat(orm)!: rework the event builder into a fluent, quoted, tested API"
```

---

### Task 8: Engines without events throw `MethodNotImplemented`

**Files:**
- Modify: `packages/orm-sql/src/compilers.ts` (after `SqlDropEventQueryCompiler`)
- Modify: `packages/orm-sqlite/src/index.ts`, `packages/orm-postgres/src/index.ts`, `packages/orm-mssql/src/index.ts` (`resolve()`)
- Test: `packages/orm-sqlite/test/dialect.test.ts`, `packages/orm-postgres/test/dialect.test.ts`, `packages/orm-mssql/test/dialect.test.ts`

**Interfaces:**
- Consumes: `EventQueryCompiler`, `DropEventQueryCompiler`, `EventQueryBuilder`, `DropEventQueryBuilder` (Task 7).
- Produces from `@spinajs/orm-sql`: `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler`.

- [ ] **Step 1: Write the failing tests**

`packages/orm-postgres/test/dialect.test.ts` - in the test `leaves unsupported dialect features unregistered` remove `'EventQueryCompiler', 'DropEventQueryCompiler'` from the list (keep `'TableHistoryQueryCompiler', 'TableCloneQueryCompiler'`) and fix its doc comment to no longer mention `CREATE EVENT`. Add `MethodNotImplemented` (`@spinajs/exceptions`) and `RawQuery, SchemaQueryBuilder` (`@spinajs/orm`) to the imports, then add:

```ts
  it('refuses scheduled events, which postgres does not have natively', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);

    expect(driver.supportedFeatures().events).to.eq(false);
    expect(() => schema.createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-postgres has no native scheduled events');
    expect(() => schema.dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-postgres has no native scheduled events');
  });
```

`packages/orm-mssql/test/dialect.test.ts` - same imports, then add:

```ts
  it('refuses scheduled events, SQL Server Agent is not implemented', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);

    expect(driver.supportedFeatures().events).to.eq(false);
    expect(() => schema.createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-mssql has no native scheduled events');
    expect(() => schema.dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-mssql has no native scheduled events');
  });
```

`packages/orm-sqlite/test/dialect.test.ts` - add `MethodNotImplemented` and `RawQuery` to the imports, then inside `describe('registrations', ...)` add:

```ts
    it('refuses scheduled events, which sqlite does not have', () => {
      expect(connection.supportedFeatures().events).to.eq(false);
      expect(() => connection.schema().createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-sqlite has no native scheduled events');
      expect(() => connection.schema().dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-sqlite has no native scheduled events');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run in each of `packages/orm-postgres`, `packages/orm-mssql`, `packages/orm-sqlite`: `npx ts-mocha -p tsconfig.json test/dialect.test.ts`
Expected: the three new tests FAIL with a DI resolve error (nothing registered for `EventQueryCompiler`), not with `MethodNotImplemented`.

- [ ] **Step 3: Implement**

In `packages/orm-sql/src/compilers.ts`, add `MethodNotImplemented` to the `@spinajs/exceptions` import and, after `SqlDropEventQueryCompiler`:

```ts
/**
 * For engines with no native scheduler. Registered explicitly by those drivers, so asking for
 * an event says what is missing instead of failing inside the container.
 */
@NewInstance()
@Inject(Container)
export class UnsupportedEventQueryCompiler extends EventQueryCompiler {
  constructor(protected container: Container, protected builder: EventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    throw new MethodNotImplemented(`${this.builder.Driver.Options.Driver} has no native scheduled events`);
  }
}

@NewInstance()
@Inject(Container)
export class UnsupportedDropEventQueryCompiler extends DropEventQueryCompiler {
  constructor(protected container: Container, protected builder: DropEventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    throw new MethodNotImplemented(`${this.builder.Driver.Options.Driver} has no native scheduled events`);
  }
}
```

Run (in `packages/orm-sql`): `npm run compile` - exits 0.

In each of `packages/orm-sqlite/src/index.ts`, `packages/orm-postgres/src/index.ts`, `packages/orm-mssql/src/index.ts`: add `EventQueryCompiler, DropEventQueryCompiler` to the `@spinajs/orm` import, `UnsupportedEventQueryCompiler, UnsupportedDropEventQueryCompiler` to the `@spinajs/orm-sql` import, and at the end of `resolve()`:

```ts
    // No native scheduler in this engine, and nothing is simulated in its place.
    this.Container.register(UnsupportedEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(UnsupportedDropEventQueryCompiler).as(DropEventQueryCompiler);
```

In `packages/orm-postgres/src/index.ts` also remove `` `CREATE EVENT`, `` from the comment that lists what stays unregistered.

- [ ] **Step 4: Run the tests to verify they pass**

Run in each of the three packages: `npx ts-mocha -p tsconfig.json test/dialect.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/orm-sql/src/compilers.ts packages/orm-sqlite packages/orm-postgres packages/orm-mssql
git commit -m "feat(orm): engines without events throw MethodNotImplemented"
```

---

### Task 9: Live tests against real MySQL and SQL Server

**Files:**
- Modify: `packages/orm-mysql/test/mysql.test.ts` (append a `describe`)
- Modify: `packages/orm-mssql/test/mssql.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Start the fixtures**

Run (repo root): `docker compose --profile test up -d --wait`
Expected: `spinajs-orm-test-mysql` and `spinajs-orm-test-mssql` healthy. If docker is not available, stop and report it - do not mark this task done on compile tests alone.

- [ ] **Step 2: Write the live tests**

Append to `packages/orm-mysql/test/mysql.test.ts` (add `QueryContext` and `RawQuery` to the file's `@spinajs/orm` import):

```ts
describe('MySql views and events', () => {
  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql')!.truncate('user_test');
  });

  afterEach(async () => {
    await (DI.get(Orm) as any)?.dispose();
    DI.clearCache();
  });

  it('creates a view with an inlined binding, reads through it and drops it', async () => {
    const connection = db().Connections.get('mysql')!;

    await connection.insert().into('user_test').values({ Name: 'a', Password: 'p', CreatedAt: '2019-10-18' });
    await connection.insert().into('user_test').values({ Name: `b'c`, Password: 'p', CreatedAt: '2019-10-18' });

    await connection.schema().createView('v_user_quoted', (view) => view.orReplace().security('INVOKER').as((select) => select.from('user_test').where('Name', `b'c`)));

    const rows = (await connection.executeOnDb('SELECT Name FROM v_user_quoted', [], QueryContext.Select)) as any[];
    expect(rows.map((row) => row.Name)).to.deep.eq([`b'c`]);

    await connection.schema().dropView('v_user_quoted').ifExists();
  });

  it('creates an event the scheduler accepts and drops it', async () => {
    const connection = db().Connections.get('mysql')!;

    await connection.schema().dropEvent('ev_orm_test').ifExists();
    await connection.schema().createEvent('ev_orm_test', (event) =>
      event
        .every(1, 'DAY')
        .disabled()
        .comment(`orm's test`)
        .do([connection.del().from('user_test').where('Name', 'never'), new RawQuery('DELETE FROM user_test WHERE Name = ?', ['never either'])]),
    );

    const rows = (await connection.executeOnDb("SELECT STATUS, INTERVAL_VALUE, INTERVAL_FIELD, EVENT_COMMENT FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'ev_orm_test'", [], QueryContext.Select)) as any[];

    expect(rows).to.have.lengthOf(1);
    expect(rows[0].STATUS).to.eq('DISABLED');
    expect(String(rows[0].INTERVAL_VALUE)).to.eq('1');
    expect(rows[0].INTERVAL_FIELD).to.eq('DAY');
    expect(rows[0].EVENT_COMMENT).to.eq(`orm's test`);

    await connection.schema().dropEvent('ev_orm_test');
  });
});
```

Append to `packages/orm-mssql/test/mssql.test.ts` (add `QueryContext` to the file's `@spinajs/orm` import):

```ts
describe('MsSql views', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    await DI.resolve(Orm);

    await db().Connections.get('mssql')!.truncate('user_test');
    await db().Migration.up();
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('creates or alters a view with an inlined binding, reads through it and drops it', async () => {
    const connection = db().Connections.get('mssql')!;

    await connection.insert().into('user_test').values({ Name: 'a', Password: 'p', CreatedAt: '2019-10-18' });
    await connection.insert().into('user_test').values({ Name: 'b', Password: 'p', CreatedAt: '2019-10-18' });

    const create = () => connection.schema().createView('v_user_a', (view) => view.orReplace().as((select) => select.from('user_test').where('Name', 'a')));

    await create();
    // a second run must ALTER, not fail
    await create();

    const rows = (await connection.executeOnDb('SELECT Name FROM v_user_a', [], QueryContext.Select)) as any[];
    expect(rows.map((row) => row.Name)).to.deep.eq(['a']);

    await connection.schema().dropView('v_user_a').ifExists();
  });
});
```

- [ ] **Step 3: Run the live tests**

Run (in `packages/orm-mysql`): `npx ts-mocha -p tsconfig.json test/mysql.test.ts -g "views and events"` - Expected: 2 passing.
Run (in `packages/orm-mssql`): `npx ts-mocha -p tsconfig.json test/mssql.test.ts -g "MsSql views"` - Expected: 1 passing.

If the MSSQL select inside the view fails on a construct the mssql select compiler emits (it is a different compiler from the no-DB tests' raw bodies), fix `MsSqlCreateViewCompiler` - not the test - and add the failing SQL as a no-DB case in `packages/orm-mssql/test/view.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/orm-mysql/test/mysql.test.ts packages/orm-mssql/test/mssql.test.ts
git commit -m "test(orm): live view and event round trips on mysql and mssql"
```

---

### Task 10: Documentation, full verification, pull request

**Files:**
- Modify: `packages/orm/docs/10-schema-and-migrations.md` (schema builder table ~line 818; new `## Views` section before `## Database events`; rewrite `## Database events` ~lines 1099-1143; the raw DDL sample ~line 1155)
- Modify: `packages/orm-mysql/docs/02-dialect-notes.md` (event sample ~lines 157-190)
- Modify: `packages/orm-sql/docs/02-compilers.md` (~lines 193-210)

- [ ] **Step 1: Update `packages/orm/docs/10-schema-and-migrations.md`**

In the schema builder table replace the `event(name)` row and add the view row:

```md
| `createView(name, cb)` | `CreateViewQueryBuilder` |
| `dropView(name, schema?)` | `DropViewQueryBuilder` |
| `createEvent(name, cb)` / `dropEvent(name)` | `EventQueryBuilder` / `DropEventQueryBuilder` |
```

Insert before `## Database events`:

````md
## Views

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class ActiveOrdersView_2026_09_19_10_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createView('v_active_orders', (view) => {
      view.columns(['Id', 'Total']).as((select) => select.select('Id').select('Total').from('orders').where('Status', 'open'));
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropView('v_active_orders').ifExists();
  }
}
```

`as()` takes a callback that receives a fresh select builder, a ready `SelectQueryBuilder`, or a
`RawQuery`. No engine accepts parameters inside a view definition, so the values of the body are
written into the SQL as literals by the driver's `LiteralQuoter`; the compiled statement never
carries bindings.

Optional clauses exist only where the engine has them. Anything else throws
`MethodNotImplemented` - nothing is simulated.

| Method | MySQL | SQLite | PostgreSQL | MSSQL |
| --- | --- | --- | --- | --- |
| `columns([...])` | yes | yes | yes | yes |
| `orReplace()` | `OR REPLACE` | throws | `OR REPLACE` | `CREATE OR ALTER` |
| `ifNotExists()` | throws | yes | throws | throws |
| `algorithm('UNDEFINED' \| 'MERGE' \| 'TEMPTABLE')` | yes | throws | throws | throws |
| `security('DEFINER' \| 'INVOKER')` | `SQL SECURITY` | throws | `security_invoker` ( 15+ ) | throws |
| `checkOption('CASCADED' \| 'LOCAL'?)` | yes | throws | yes | plain form only |
| `temporary()` | throws | `TEMP` | `TEMPORARY` | throws |

MSSQL also refuses `database()` on a view: T-SQL does not allow a database prefix there.
````

Replace the whole `## Database events` section (heading through the `ScheduleQueryBuilder` sentence) with:

````md
## Database events

Scheduled jobs inside the database engine. **Only MySQL has them.** On SQLite, PostgreSQL and
MSSQL the builders throw `MethodNotImplemented` when compiled; guard with
`supportedFeatures().events` when a migration must run everywhere.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class ScheduleCleanup_2026_07_27_17_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().createEvent('purge_old_sessions', (event) => {
      event
        .every(1, 'HOUR')
        .comment('Delete sessions older than a day')
        .do(connection.del().from('sessions').where('CreatedAt', '<', '2026-01-01'));
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().dropEvent('purge_old_sessions').ifExists();
  }
}
```

`EventQueryBuilder` - every method chains:

| Method | Effect |
| --- | --- |
| `every(n, unit)` | Repeat. `unit` is `YEAR`, `QUARTER`, `MONTH`, `WEEK`, `DAY`, `HOUR`, `MINUTE` or `SECOND`. |
| `at(dateTime)` | Run once at a luxon `DateTime`. |
| `fromNow(n, unit)` | Run once at `now + interval`. |
| `starts(dateTime)` / `ends(dateTime)` | Window of a recurring event. Only valid with `every()`. |
| `preserve()` | `ON COMPLETION PRESERVE`. Default is `NOT PRESERVE`. |
| `disabled()` | Create the event disabled. Default is enabled. |
| `ifNotExists()` | `CREATE EVENT IF NOT EXISTS`. |
| `comment(text)` | Stored with the event. |
| `do(sql)` | A `RawQuery`, a query builder, or an array of them. |

`every()`, `at()` and `fromNow()` are mutually exclusive. One action is emitted as given after
`DO` - a single statement, or a `RawQuery` that carries its own `BEGIN ... END` block. Several
actions are wrapped in `BEGIN ... END`, one statement per line. Values are inlined as literals,
as in views. `dropEvent(name)` emits `IF EXISTS` only after `.ifExists()`.
````

In the `## Raw DDL` sample replace the `CREATE VIEW` raw call with a statement the builders do not cover, keeping the index line:

```ts
    await connection.schema().raw('ALTER TABLE orders ADD CONSTRAINT chk_total CHECK (Total >= 0)');
```

and delete the `down()` body's `dropView` line in that sample, replacing it with:

```ts
    await connection.schema().raw('ALTER TABLE orders DROP CONSTRAINT chk_total');
```

- [ ] **Step 2: Update the driver docs**

`packages/orm-mysql/docs/02-dialect-notes.md`, section `## Database events`: replace the four-line event construction in the sample with

```ts
    await connection.schema().createEvent('purge_old_sessions', (event) => {
      event
        .every(1, 'HOUR')
        .comment('Delete sessions older than a day')
        .do(connection.del().from('sessions').where('CreatedAt', '<', '2026-01-01'));
    });
```

and the drop line with `await connection.schema().dropEvent('purge_old_sessions').ifExists();`. Remove the now unused `const event` / `await event;` lines.

`packages/orm-sql/docs/02-compilers.md`: under `SqlDropTableQueryCompiler / SqlDropViewQueryCompiler` add a `## SqlCreateViewQueryCompiler` section:

```md
## `SqlCreateViewQueryCompiler`

`CREATE VIEW <name> [(columns)] AS <body>` - the portable core only. Every optional clause
( `OR REPLACE`, `IF NOT EXISTS`, `TEMPORARY`, `ALGORITHM`, `SQL SECURITY`, `CHECK OPTION` )
throws `MethodNotImplemented` here; a driver subclasses it and overrides the hook of each clause
its engine has. It is NOT registered by `SqlDriver` - every driver registers its own subclass.
The body's bindings are inlined through `inlineBindings()` and the driver's `LiteralQuoter`.
```

and replace the text of `## SqlEventQueryCompiler / SqlDropEventQueryCompiler` with:

```md
MySQL's `CREATE EVENT` / `DROP EVENT`, from `EventQueryBuilder`. Both return a single output
with no bindings. Registered by the MySQL driver only; sqlite, postgres and mssql register
`UnsupportedEventQueryCompiler` / `UnsupportedDropEventQueryCompiler`, which throw
`MethodNotImplemented`.
```

- [ ] **Step 3: Full build, doc samples, package suites**

Run (repo root): `npm run build` - Expected: exits 0.
Run (repo root): `npm run docs:check` - Expected: no diagnostics.
Run `npm test` in `packages/orm`, `packages/orm-sql`, `packages/orm-sqlite`, `packages/orm-postgres`, and (fixtures up) `packages/orm-mysql`, `packages/orm-mssql`.
Expected: no failure that does not also fail on `master` in the same environment. Record the pass / fail counts of each package in the PR description.

- [ ] **Step 4: Commit, push, open the pull request**

```bash
git add packages/orm/docs packages/orm-mysql/docs packages/orm-sql/docs
git commit -m "docs(orm): views and the reworked event builder"
git push -u origin feat/orm-view-event-builders
gh pr create --repo spinajs/main --base master --title "feat(orm): createView and a reworked createEvent, per dialect" --body-file <(cat <<'EOF'
## What
- `schema().createView(name, cb)` on mysql, sqlite, postgres and mssql
- `schema().createEvent(name, cb)` / `dropEvent(name).ifExists()` reworked (MySQL only)
- `LiteralQuoter` per driver: view and event bodies cannot bind, values are inlined
- a clause an engine does not have throws `MethodNotImplemented`, nothing is simulated

## Breaking
- `schema().event(name)` -> `schema().createEvent(name, cb)`; `EventIntervalDesc` and `ScheduleQueryBuilder` removed
- `dropEvent(name)` no longer implies `IF EXISTS`, call `.ifExists()`
- `EventQueryCompiler` / `DropEventQueryCompiler` return a single `ICompilerOutput`
- sqlite, postgres and mssql now register event compilers that throw, instead of leaving them unregistered

## Tests
PASS_FAIL_COUNTS
EOF
)
```

Before running it, replace the `PASS_FAIL_COUNTS` line with the per-package pass / fail counts recorded in step 3. Pushing and opening the PR are outward-facing: confirm with the user before running this step.

# Lane L1: ORM middleware hooks, afterCommit and raw column bindings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints are binding.

**Goal:** Implement overview decisions 6, 18 and 19 in the ORM packages: `QueryMiddleware` gains an optional `afterQueryExecution(query, result)` and an optional `transactional(query): boolean`, and `Builder._run()` runs the before hooks, the statement and the after hooks inside `driver.transaction()` when a middleware asks for it and no transaction is in scope (decision 6); `OrmDriver.afterCommit(cb)` runs a callback after the outermost commit and drops it on rollback (decision 18); raw select columns keep their bindings in `@spinajs/orm-sql` (decision 19).

**Architecture:** Both members are optional class members (no body, no `abstract`), so `AuthzQueryMiddleware`, `IntlQueryMiddleware` and every test middleware compile unchanged. `Builder._run()` moves "before hooks, driver call, after hooks" into one private method and calls it either directly or inside `this._driver.transaction()`. Hydration and result middlewares stay outside the transaction, after the commit. `afterCommit` callbacks live on the `ITransactionContext` of the outermost transaction; a savepoint remembers how many there were when it began and cuts the list back to that on rollback. `SqlColumnsCompiler` returns the bindings its column statements build, and `SqlSelectQueryCompiler` puts them first, matching the position of the columns in the SQL.

**Tech Stack:** TypeScript (node16 ESM), `@spinajs/orm` (`OrmDriver.transaction`, AsyncLocalStorage `CurrentTransaction`), mocha 10 + ts-mocha + chai 4 + chai-as-promised + sinon, `@spinajs/orm-sqlite` (in-memory SQLite) for the database test.

**Depends on:** nothing (wave 1).

**Blocks:** L3's ancestor maintenance tasks (the write-side middleware needs `afterQueryExecution` and `transactional`) and its `AuthzChange` publishing (`afterCommit`); L4's `.withAccess()` (raw select columns with bindings).

## Global Constraints

- All code, comments, identifiers, docs and commit messages in English. Comments only where a reader would ask "why?".
- No backward-compatibility break: both new members are optional; existing middlewares must keep compiling and behaving the same.
- Ordering contract (documented on `QueryMiddleware`): after hooks run in the same order as before hooks (ascending `order`, ties in DI registration order); an after hook runs only if every earlier one resolved; an after hook that throws rejects the query and, when the query was wrapped, rolls the wrapped transaction back. Inside a caller's transaction the builder opens no savepoint and does not consult `transactional`; the caller's transaction decides.
- Commit after every task with a conventional message.
- **Running one test file.** Mocha 10 concatenates the `spec` of `.mocharc.json` with files given on the command line, so this lane runs single files with the config switched off and the loader restated. Shorthand used below:
  - `ONE` = `npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 30000`
- `packages/orm-sqlite` imports the built `@spinajs/orm` and `@spinajs/orm-sql` (`lib/mjs`): run `npm run compile` in the changed package before the orm-sqlite tests.
- `afterCommit` contract (documented on the method): outside a transaction the callback runs at once (awaited by `afterCommit`); inside one it is queued on the transaction in scope and runs after the OUTERMOST commit, after the connection is released, in registration order, each awaited, before `transaction()` resolves; a callback that throws is logged on the driver's log and never rethrown, and the next one still runs. A rollback of the outermost transaction (also a failed commit) drops every queued callback. A rollback to a savepoint drops exactly the callbacks queued since that savepoint began, including those of savepoints nested in it that were released; callbacks queued before it, or after it ended, are kept. Savepoints of one transaction run one after another (they share one connection), which is what makes "since it began" exact.

## Files

- Modify: `packages/orm/src/interfaces.ts:1649-1692` (`QueryMiddleware` doc, `afterQueryExecution?`, `transactional?`)
- Modify: `packages/orm/src/builders.ts:86-109` (`Builder._run()` and new private `_executeWithQueryMiddlewares()`)
- Create: `packages/orm/test/query-middleware-hooks.test.ts` (fake driver: ordering, wrapping, rollback, nesting, memo)
- Create: `packages/orm-sqlite/test/queryMiddlewareTransaction.test.ts` (real in-memory SQLite: commit and rollback of the statement with the after hook's write)
- Modify: `packages/orm/src/interfaces.ts:1935-1944` (`ITransactionContext.afterCommit`)
- Modify: `packages/orm/src/driver.ts:455-508` (`transaction()`), add `afterCommit()` and `_runAfterCommit()`
- Modify: `packages/orm/test/driver.test.ts` (afterCommit tests on `FakeTxDriver`)
- Modify: `packages/orm-sql/src/compilers.ts:252-265,370-427` (`SqlColumnsCompiler.columns`, `SqlSelectQueryCompiler.compile` and `select`)
- Modify: `packages/orm-sql/test/queryBuilder.test.ts` (raw select column bindings)
- Create: `packages/orm-sqlite/test/rawSelectBindings.test.ts` (the binding reaches SQLite)

Facts checked for this lane:
- `Builder._run()` (`packages/orm/src/builders.ts:94-177`) awaits every `beforeQueryExecution` (L105-107), then `this._driver.execute(this)` (L109), then result middlewares and hydration. `SelectQueryBuilder._run()` (L1687) calls `super._run()`, so the change covers every builder.
- `OrmDriver.CurrentTransaction` (`packages/orm/src/driver.ts:70-72`) reads a per-driver `AsyncLocalStorage`; `transaction(cb)` (L471-508) commits on resolve, rolls back on throw, disposes once, and takes a savepoint when a transaction is already in scope.
- `FakeSqliteDriver` (`packages/orm/test/misc.ts:1066-1142`) implements `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint` and `_dispose` as no-ops, so `transaction()` works on it unchanged; the tests spy on those methods. Nothing has to be added to `misc.ts`.
- No test in `packages/orm/test` uses a real SQLite driver (only comments mention `orm-sqlite`). `packages/orm-sqlite/test/uowFixture.ts` boots an in-memory SQLite ORM with real tables (`uow_tag`, `uow_client`, …) and is used by `relationAtomicity.test.ts` for rollback tests; Task 2 reuses it.
- The raw select column bug: `SqlColumnRawStatement.build()` (`packages/orm-sql/src/statements.ts:620-631`) does return `RawQuery.Bindings`, but `SqlColumnsCompiler.columns()` (`packages/orm-sql/src/compilers.ts:252-265`) returns `bindings: []` and keeps only `Statements[0]`, and `SqlSelectQueryCompiler.select()` (L415-427) returns only the expression, so `compile()` (L370-403) never sees them. The fix is in the compiler; the statement stays as it is. No dialect package (`orm-sqlite`, `orm-mysql`, `orm-mssql`, `orm-postgres`) overrides either class.
- `FakeTxDriver` in `packages/orm/test/driver.test.ts` (L22-89) records every transaction primitive in `calls` and is built with `new`, so `resolve()` never sets its `Log`; the afterCommit tests set a fake `Log` themselves and the driver code reads `this.Log?.error`.
- `packages/orm/test/model.test.ts` asserts the number of mock models (26), so the tests below add no model under `test/mocks/models`; they use `Model1` (select) and `RawModel` (no soft delete, so `destroy(1)` is a `DeleteQueryBuilder` with `QueryContext.Delete`).

---

### Task 1: optional `afterQueryExecution` and `transactional`, and the wrapped execution in `Builder._run()`

**Files:**
- Modify: `packages/orm/src/interfaces.ts:1649-1692`
- Modify: `packages/orm/src/builders.ts:86-109`
- Test: `packages/orm/test/query-middleware-hooks.test.ts`

**Interfaces:**
- Produces (from `@spinajs/orm`):
  - `QueryMiddleware.afterQueryExecution?(query: QueryBuilder, result: unknown): void | Promise<void>`: called once per builder right after the driver call with the driver's raw result (rows for a select, the driver's update/insert result otherwise), before result middlewares and hydration.
  - `QueryMiddleware.transactional?(query: QueryBuilder): boolean`: called with the completed builder before `beforeQueryExecution`, only when no transaction is in scope; `true` from any middleware makes the builder run before hooks, statement and after hooks inside `this.Driver.transaction()`.
  - L3 relies on: inside a wrapped query, `query.Driver.CurrentTransaction` is defined in `beforeQueryExecution`, during the statement and in `afterQueryExecution`, and statements a hook issues on the same driver join that transaction.

- [ ] **Step 1: Write the failing tests**

Create `packages/orm/test/query-middleware-hooks.test.ts`:

```ts
/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, QueryMiddleware, QueryContext } from '../src/interfaces.js';
import type { ITransactionContext } from '../src/interfaces.js';
import { QueryBuilder } from '../src/builders.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator, OneToManyRelationHydrator } from '../src/hydrators.js';
import { Orm } from '../src/orm.js';
import { Model1 } from './mocks/models/Model1.js';
import { RawModel } from './mocks/models/RawModel.js';
import '../src/bootstrap.js';
import '@spinajs/log';

chai.use(chaiAsPromised);
const expect = chai.expect;

/** Hook and driver calls in order, each with the transaction in scope when it ran. */
const CALLS: { what: string; tx: ITransactionContext | undefined }[] = [];
/** What the stubbed driver returns; after hooks must receive this very object. */
const ROWS: unknown[] = [];
const RESULTS: unknown[] = [];
const ASKED: QueryBuilder[] = [];
let failBefore = false;
let failAfter = false;
let driver: FakeSqliteDriver;

const record = (what: string): void => {
  CALLS.push({ what, tx: driver.CurrentTransaction });
};
const sequence = (): string[] => CALLS.map((c) => c.what);

const ALL_HOOKS = ['before:Plain', 'before:DeleteGuard', 'before:Early', 'before:Late', 'execute', 'after:DeleteGuard', 'after:Early', 'after:Late'];

class Plain extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Plain');
  }
}

/** Asks for a transaction around deletes only. */
class DeleteGuard extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:DeleteGuard');
    if (failBefore) throw new Error('before hook failed');
  }

  public async afterQueryExecution(): Promise<void> {
    record('after:DeleteGuard');
    if (failAfter) throw new Error('after hook failed');
  }

  public transactional(query: QueryBuilder): boolean {
    ASKED.push(query);
    return query.QueryContext === QueryContext.Delete;
  }
}

class Early extends QueryMiddleware {
  public order = 100;

  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Early');
  }

  public async afterQueryExecution(): Promise<void> {
    record('after:Early');
  }
}

class Late extends QueryMiddleware {
  public order = 1000;

  public afterQueryCreation(): void {}

  public async beforeQueryExecution(): Promise<void> {
    record('before:Late');
  }

  public async afterQueryExecution(_query: QueryBuilder, result: unknown): Promise<void> {
    record('after:Late');
    RESULTS.push(result);
  }
}

const OWN = [Plain, DeleteGuard, Early, Late];

describe('Query middleware afterQueryExecution and transactional', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(OneToOneRelationHydrator).as(ModelHydrator);
    DI.register(JunctionModelPropertyHydrator).as(ModelHydrator);
    DI.register(OneToManyRelationHydrator).as(ModelHydrator);

    for (const m of OWN) DI.register(m).as(QueryMiddleware);

    DI.removeAllListeners('di.resolved.Configuration');

    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper)) as Bootstrapper[];
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    const orm = await DI.resolve(Orm);
    driver = orm.Connections.get('sqlite') as FakeSqliteDriver;

    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async () => {
      record('execute');
      return ROWS;
    });

    CALLS.length = 0;
    RESULTS.length = 0;
    ASKED.length = 0;
    failBefore = false;
    failAfter = false;
  });

  afterEach(() => {
    sinon.restore();
    for (const m of OWN) DI.unregister(m);
    DI.clearCache();
  });

  const spies = () => ({
    begin: sinon.spy(driver as any, '_begin'),
    commit: sinon.spy(driver as any, '_commit'),
    rollback: sinon.spy(driver as any, '_rollback'),
    savepoint: sinon.spy(driver as any, '_savepoint'),
  });

  it('leaves both new members optional', () => {
    const plain = new Plain();

    expect(plain.afterQueryExecution).to.equal(undefined);
    expect(plain.transactional).to.equal(undefined);
  });

  it('runs afterQueryExecution after the driver, in the order of beforeQueryExecution, with the raw result', async () => {
    await Model1.select();

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(RESULTS).to.have.length(1);
    expect(RESULTS[0]).to.equal(ROWS);
  });

  it('opens no transaction when no middleware asks for one', async () => {
    const s = spies();

    await Model1.select();

    expect(s.begin.called).to.equal(false);
    expect(CALLS.every((c) => c.tx === undefined)).to.equal(true);
    expect(ASKED).to.have.length(1);
    expect(ASKED[0].QueryContext).to.equal(QueryContext.Select);
  });

  it('runs before hooks, the statement and after hooks in one transaction when a middleware asks for it', async () => {
    const s = spies();

    await RawModel.destroy(1);

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(s.begin.calledOnce).to.equal(true);
    expect(s.commit.calledOnce).to.equal(true);
    expect(s.rollback.called).to.equal(false);
    expect(CALLS[0].tx).to.not.equal(undefined);
    expect(CALLS.every((c) => c.tx === CALLS[0].tx)).to.equal(true);
    expect(driver.CurrentTransaction).to.equal(undefined);
    expect(ASKED).to.have.length(1);
    expect(ASKED[0].QueryContext).to.equal(QueryContext.Delete);
    expect(RESULTS[0]).to.equal(ROWS);
  });

  it('rolls the transaction back and rejects when an after hook throws', async () => {
    const s = spies();
    failAfter = true;

    await expect(RawModel.destroy(1)).to.be.rejectedWith('after hook failed');

    expect(sequence()).to.eql(ALL_HOOKS.slice(0, 6));
    expect(s.rollback.calledOnce).to.equal(true);
    expect(s.commit.called).to.equal(false);
  });

  it('rolls the transaction back without running the statement when a before hook throws', async () => {
    const s = spies();
    failBefore = true;

    await expect(RawModel.destroy(1)).to.be.rejectedWith('before hook failed');

    expect(sequence()).to.eql(['before:Plain', 'before:DeleteGuard']);
    expect(s.rollback.calledOnce).to.equal(true);
    expect(s.commit.called).to.equal(false);
  });

  it('joins a caller transaction without a savepoint and without asking transactional', async () => {
    const s = spies();
    const seen: { outer?: ITransactionContext } = {};

    await driver.transaction(async () => {
      seen.outer = driver.CurrentTransaction;
      await RawModel.destroy(1);
    });

    expect(seen.outer).to.not.equal(undefined);
    expect(sequence()).to.eql(ALL_HOOKS);
    expect(CALLS.every((c) => c.tx === seen.outer)).to.equal(true);
    expect(s.begin.calledOnce).to.equal(true);
    expect(s.savepoint.called).to.equal(false);
    expect(s.commit.calledOnce).to.equal(true);
    expect(ASKED).to.have.length(0);
  });

  it('cannot roll anything back when no middleware asked for a transaction', async () => {
    const s = spies();
    failAfter = true;

    await expect(Model1.select()).to.be.rejectedWith('after hook failed');

    expect(sequence()).to.include('execute');
    expect(s.begin.called).to.equal(false);
    expect(s.rollback.called).to.equal(false);
  });

  it('runs the hooks and the transaction once when a builder is awaited twice', async () => {
    const s = spies();
    const query = RawModel.destroy(1);

    await query;
    await query;

    expect(sequence()).to.eql(ALL_HOOKS);
    expect(s.begin.calledOnce).to.equal(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/orm && ONE test/query-middleware-hooks.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2339: Property 'afterQueryExecution' does not exist on type 'Plain'` (and the same for `transactional`).

- [ ] **Step 3: Declare the optional members on `QueryMiddleware`**

In `packages/orm/src/interfaces.ts`, replace the whole block from line 1649 (`/**` above `Hooks into the lifetime of every query builder.`) to the closing `}` of `export abstract class QueryMiddleware` (line 1692) with:

```ts
/**
 * Hooks into the lifetime of every query builder. The hooks run for EVERY builder type —
 * select, insert, update and delete.
 *
 * The two required hooks differ in what the query is guaranteed to contain, and that
 * difference is load-bearing rather than stylistic:
 *
 * - `afterQueryCreation` runs from the builder's CONSTRUCTOR. The model and the query context
 *   are set; nothing the caller does afterwards has happened yet — no `where()`, no
 *   `update()`, no `values()`. It is the place to ADD a constraint (rbac appends its owner
 *   `WHERE` here) and the wrong place to read or amend the payload, which does not exist yet.
 * - `beforeQueryExecution` runs once per builder, immediately before the driver is called, so
 *   the query is complete. It is the place to inspect or rewrite what is about to be written
 *   (rbac stamps the owner column of an INSERT here, because a value written at construction
 *   would be overwritten by the caller's own `values()` call).
 *
 * The optional `afterQueryExecution` runs once per builder right after the driver call, in the
 * same order as `beforeQueryExecution`. When any middleware's optional `transactional` answers
 * true and no transaction is in scope, the builder runs the before hooks, the statement and the
 * after hooks inside one `driver.transaction()`, so a hook that throws also rolls the statement
 * back. Inside a caller's transaction the caller's transaction is used as it is.
 *
 * A middleware that throws from any hook aborts the query.
 */
export abstract class QueryMiddleware {
  /**
   * Position in the pipeline: lower runs first, ties keep registration order. Every hook
   * follows it. authz scopes queries at 100 and intl-orm translates at 1000, so translation
   * never runs on a query authz has not scoped yet.
   */
  public order = 0;

  /**
   * Called from the builder's constructor, before the caller has added anything to it.
   *
   * @param query - the freshly constructed builder
   */
  abstract afterQueryCreation(query: QueryBuilder): void;

  /**
   * Called once per builder immediately before execution, with the query fully assembled.
   *
   * May be async. Hooks are awaited in registration order, so one that has to consult the
   * database before deciding — an rbac rule whose ownership lives in another table — can
   * do so and still abort the query by throwing.
   *
   * @param query - the completed builder
   */
  abstract beforeQueryExecution(query: QueryBuilder): void | Promise<void>;

  /**
   * Called once per builder right after the driver returned, before result middlewares and
   * hydration. Awaited in the same order as `beforeQueryExecution`; a hook runs only when every
   * earlier one resolved.
   *
   * @param query - the executed builder
   * @param result - the driver's raw result: rows for a select, the driver's write result otherwise
   */
  afterQueryExecution?(query: QueryBuilder, result: unknown): void | Promise<void>;

  /**
   * Whether this middleware needs the before hooks, the statement and the after hooks in one
   * transaction. Asked with the completed builder before `beforeQueryExecution`, and only when
   * no transaction is in scope on the builder's driver. Must answer synchronously.
   *
   * @param query - the completed builder
   */
  transactional?(query: QueryBuilder): boolean;
}
```

- [ ] **Step 4: Wrap the execution in `Builder._run()`**

In `packages/orm/src/builders.ts`, replace lines 86-109 (from the doc comment `The execution engine. …` through `const result = (await this._driver.execute(this)) as T;`):

```ts
  /**
   * The execution engine. Sends the compiled query to the driver, applies the
   * result middlewares, hydrates models and awaits the post-hydration middlewares.
   *
   * Always *returns* its value — the caller's promise chain is what propagates it.
   * Subclasses override this (not `execute()`) so that their extra work also lands
   * inside the memo.
   */
  protected async _run(): Promise<T> {
    // Fires for EVERY builder type, not just SELECT. This used to live on
    // `SelectQueryBuilder._run`, so an INSERT/UPDATE/DELETE never reached a
    // `beforeQueryExecution` hook at all — which silently disabled any middleware that
    // needs the finished query (rbac's insert-ownership check is exactly that: the payload
    // does not exist until `values()` has been called, long after construction).
    //
    // Awaited in sequence, not `forEach`ed: a hook that needs a database round-trip to
    // decide — an rbac rule whose ownership lives in another table — could otherwise only
    // return a promise into the void, and the query would execute anyway. For a security
    // check that is the difference between enforcing and pretending to.
    for (const middleware of this._queryMiddlewares) {
      await middleware.beforeQueryExecution(this as unknown as QueryBuilder);
    }

    const result = (await this._driver.execute(this)) as T;
```

with:

```ts
  /**
   * The execution engine. Sends the compiled query to the driver, applies the
   * result middlewares, hydrates models and awaits the post-hydration middlewares.
   *
   * Always *returns* its value — the caller's promise chain is what propagates it.
   * Subclasses override this (not `execute()`) so that their extra work also lands
   * inside the memo.
   */
  protected async _run(): Promise<T> {
    const wrap = this._driver.CurrentTransaction === undefined && this._queryMiddlewares.some((m) => m.transactional?.(this as unknown as QueryBuilder) === true);
    const result = wrap ? await this._driver.transaction(() => this._executeWithQueryMiddlewares()) : await this._executeWithQueryMiddlewares();
```

and insert this method directly above the doc comment of `_run()` (that is, after `protected _executionPromise: Promise<T> | null = null;`):

```ts

  /** Before hooks, the driver call and after hooks: the part `_run()` may put in a transaction. */
  private async _executeWithQueryMiddlewares(): Promise<T> {
    const query = this as unknown as QueryBuilder;

    // Fires for EVERY builder type, not just SELECT. This used to live on
    // `SelectQueryBuilder._run`, so an INSERT/UPDATE/DELETE never reached a
    // `beforeQueryExecution` hook at all — which silently disabled any middleware that
    // needs the finished query (rbac's insert-ownership check is exactly that: the payload
    // does not exist until `values()` has been called, long after construction).
    //
    // Awaited in sequence, not `forEach`ed: a hook that needs a database round-trip to
    // decide — an rbac rule whose ownership lives in another table — could otherwise only
    // return a promise into the void, and the query would execute anyway. For a security
    // check that is the difference between enforcing and pretending to.
    for (const middleware of this._queryMiddlewares) {
      await middleware.beforeQueryExecution(query);
    }

    const result = (await this._driver.execute(this)) as T;

    for (const middleware of this._queryMiddlewares) {
      await middleware.afterQueryExecution?.(query, result);
    }

    return result;
  }
```

The rest of `_run()` (from `// Snapshot the pipeline once, *after* the driver call` to its end) stays as it is: result middlewares, hydration and `afterHydration` run after the commit, outside the transaction.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd packages/orm && ONE test/query-middleware-hooks.test.ts`
Expected: PASS, `9 passing`.

- [ ] **Step 6: Run the existing middleware and driver tests**

Run: `cd packages/orm && ONE test/query-middleware.test.ts test/query-middleware-order.test.ts test/driver.test.ts`
Expected: PASS, `0 failing` (the order test still sees `beforeQueryExecution` in ascending order; the transaction contract tests are untouched).

- [ ] **Step 7: Run the package suite and the dependants that subclass `QueryMiddleware`**

Run: `cd packages/orm && npm test`
Expected: `0 failing`.

Run: `cd packages/orm && npm run compile && cd ../intl-orm && npm test`
Expected: `0 failing` (`IntlQueryMiddleware` implements neither new member and behaves as before). `AuthzQueryMiddleware` in `packages/authz-orm` is deleted by L3; it compiles unchanged meanwhile because both members are optional.

- [ ] **Step 8: Commit**

```bash
git add packages/orm/src/interfaces.ts packages/orm/src/builders.ts packages/orm/test/query-middleware-hooks.test.ts
git commit -m "feat(orm): QueryMiddleware.afterQueryExecution and transactional; Builder runs hooks and statement in one transaction on request"
```

---

### Task 2: the wrapped execution on a real database (SQLite)

**Files:**
- Create: `packages/orm-sqlite/test/queryMiddlewareTransaction.test.ts`

**Interfaces:**
- Consumes: `QueryMiddleware.afterQueryExecution?`, `QueryMiddleware.transactional?` (Task 1); `bootUow()`, `registerUowConnection()`, `rows(table)`, `UowTag`, `UowClient` from `packages/orm-sqlite/test/uowFixture.ts`.
- Produces: a pinned guarantee L3 depends on: a write issued from `afterQueryExecution` on the same driver commits or rolls back together with the statement.

This task pins Task 1 on a real database, so its tests pass on their first run. The third test is the control: the same failing after hook without `transactional` leaves the row in place, which shows the other tests would fail without the wrap.

- [ ] **Step 1: Write the tests**

Create `packages/orm-sqlite/test/queryMiddlewareTransaction.test.ts`:

```ts
/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext, QueryMiddleware } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows, UowClient, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

let asksForTransaction = true;
let failAfter = false;

const isTagWrite = (query: QueryBuilder): boolean => query.Model === UowTag && query.QueryContext !== QueryContext.Select;

/** Writes an audit row after every write to uow_tag, the way authz-orm keeps its closure table. */
class TagAudit extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public beforeQueryExecution(): void {}

  public async afterQueryExecution(query: QueryBuilder): Promise<void> {
    if (!isTagWrite(query)) return;
    if (failAfter) throw new Error('after hook failed');
    await UowClient.insert({ Name: 'audit' });
  }

  public transactional(query: QueryBuilder): boolean {
    return asksForTransaction && isTagWrite(query);
  }
}

describe('query middleware transactions on sqlite', function () {
  this.timeout(10000);

  before(() => {
    registerUowConnection();
    DI.register(TagAudit).as(QueryMiddleware);
  });

  after(() => {
    DI.unregister(TagAudit);
  });

  beforeEach(async () => {
    asksForTransaction = true;
    failAfter = false;
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('commits the statement and the after hook write together', async () => {
    await UowTag.insert({ Name: 'red' });

    expect(await rows('uow_tag')).to.have.length(1);
    expect((await rows('uow_client')).map((r) => r.Name)).to.eql(['audit']);
  });

  it('rolls the statement back when the after hook throws', async () => {
    failAfter = true;

    await expect(UowTag.insert({ Name: 'red' })).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(0);
  });

  it('keeps the statement when the middleware does not ask for a transaction', async () => {
    asksForTransaction = false;
    failAfter = true;

    await expect(UowTag.insert({ Name: 'red' })).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(1);
  });

  it('wraps a delete the same way', async () => {
    await UowTag.insert({ Name: 'red' });
    failAfter = true;

    await expect(UowTag.destroy(1)).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(1);
  });

  it('leaves both writes to a caller transaction', async () => {
    await expect(
      UowTag.transaction(async () => {
        await UowTag.insert({ Name: 'red' });
        throw new Error('caller failed');
      }),
    ).to.be.rejectedWith('caller failed');

    expect(await rows('uow_tag')).to.have.length(0);
    expect(await rows('uow_client')).to.have.length(0);
  });
});
```

- [ ] **Step 2: Build the ORM and run the tests**

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && ONE test/queryMiddlewareTransaction.test.ts`
Expected: PASS, `5 passing`.

- [ ] **Step 3: Run the orm-sqlite suite**

Run: `cd packages/orm-sqlite && npm test`
Expected: `0 failing` (the middleware is unregistered after its file, and ignores every query that is not a write to `uow_tag`).

- [ ] **Step 4: Commit**

```bash
git add packages/orm-sqlite/test/queryMiddlewareTransaction.test.ts
git commit -m "test(orm-sqlite): a transactional query middleware commits and rolls back its after-hook write with the statement"
```

---

### Task 3: `OrmDriver.afterCommit(cb)`

**Files:**
- Modify: `packages/orm/src/interfaces.ts:1935-1944`
- Modify: `packages/orm/src/driver.ts:471-508`
- Test: `packages/orm/test/driver.test.ts`

**Interfaces:**
- Produces (from `@spinajs/orm`): `OrmDriver.afterCommit(cb: () => void | Promise<void>): Promise<void>` with the contract in Global Constraints; `ITransactionContext.afterCommit?: (() => void | Promise<void>)[]` (the queue; drivers do not touch it). L3 calls `query.Driver.afterCommit(() => publish(change))` from its middleware hooks; inside a query that Task 1 wrapped, the callback runs after that wrapper's commit.

- [ ] **Step 1: Write the failing tests**

In `packages/orm/test/driver.test.ts`, append after the last `});` of `describe('OrmDriver transaction contract ( F2, B24 )', …)`:

```ts

describe('OrmDriver.afterCommit ( decision 18 )', () => {
  /** A FakeTxDriver whose log records error messages ( `resolve()`, which sets the real one, never runs here ). */
  const driver = (opts?: IFakeTxDriverOptions): { d: FakeTxDriver; errors: string[] } => {
    const d = new FakeTxDriver(opts);
    const errors: string[] = [];
    (d as unknown as { Log: unknown }).Log = { error: (message: string) => errors.push(message) };
    return { d, errors };
  };

  it('runs the callback at once when no transaction is open', async () => {
    const { d } = driver();

    await d.afterCommit(() => {
      d.calls.push('cb');
    });

    expect(d.calls).to.deep.equal(['cb']);
  });

  it('runs callbacks after the outermost commit, in registration order, outside the transaction', async () => {
    const { d } = driver();
    const seen: unknown[] = [];

    const result = await d.transaction(async () => {
      await d.afterCommit(() => {
        d.calls.push('first');
        seen.push(d.CurrentTransaction);
      });
      await d.afterCommit(async () => {
        d.calls.push('second');
      });
      d.calls.push('body');
      return 'value';
    });

    expect(result).to.equal('value');
    expect(d.calls).to.deep.equal(['begin', 'body', 'commit', 'dispose', 'first', 'second']);
    expect(seen).to.deep.equal([undefined]);
  });

  it('runs a callback queued in a released savepoint only after the outermost commit', async () => {
    const { d } = driver();

    await d.transaction(async () => {
      await d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('inner');
        });
      });
      d.calls.push('after savepoint');
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint', 'releaseSavepoint', 'after savepoint', 'commit', 'dispose', 'inner']);
  });

  it('drops every callback when the outermost transaction rolls back', async () => {
    const { d } = driver();

    await expect(
      d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('cb');
        });
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(d.calls).to.deep.equal(['begin', 'rollback', 'dispose']);
  });

  it('drops every callback when the commit fails', async () => {
    const { d } = driver({ failCommit: true });

    await expect(
      d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('cb');
        });
      }),
    ).to.be.rejectedWith('commit failed');

    expect(d.calls).to.not.include('cb');
  });

  it('drops only the callbacks queued since a savepoint began when it rolls back', async () => {
    const { d } = driver();

    await d.transaction(async () => {
      await d.afterCommit(() => {
        d.calls.push('before');
      });
      await d
        .transaction(async () => {
          await d.afterCommit(() => {
            d.calls.push('inside');
          });
          await d.transaction(async () => {
            await d.afterCommit(() => {
              d.calls.push('nested released');
            });
          });
          throw new Error('savepoint fails');
        })
        .catch(() => undefined);
      await d.afterCommit(() => {
        d.calls.push('after');
      });
    });

    expect(d.calls.filter((c) => !['begin', 'savepoint', 'releaseSavepoint', 'rollbackToSavepoint', 'commit', 'dispose'].includes(c))).to.deep.equal(['before', 'after']);
  });

  it('logs a failing callback, never rethrows it, and still runs the next one', async () => {
    const { d, errors } = driver();

    const result = await d.transaction(async () => {
      await d.afterCommit(() => {
        throw new Error('publish failed');
      });
      await d.afterCommit(() => {
        d.calls.push('next');
      });
      return 1;
    });
    await d.afterCommit(async () => {
      throw new Error('immediate failed');
    });

    expect(result).to.equal(1);
    expect(d.calls).to.include('next');
    expect(errors).to.have.length(2);
    expect(errors[0]).to.include('publish failed');
    expect(errors[1]).to.include('immediate failed');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/orm && ONE test/driver.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2339: Property 'afterCommit' does not exist on type 'FakeTxDriver'`.

- [ ] **Step 3: Add the queue to `ITransactionContext`**

In `packages/orm/src/interfaces.ts`, in `export interface ITransactionContext` (L1935-1944), after the `IdentityMap?: IIdentityMap;` member add:

```ts

  /** Callbacks queued by `OrmDriver.afterCommit`, run after the outermost commit. Owned by `OrmDriver`. */
  afterCommit?: (() => void | Promise<void>)[];
```

- [ ] **Step 4: Implement `afterCommit` and run the queue in `transaction()`**

In `packages/orm/src/driver.ts`, replace the body of `transaction()` from `const active = this.TransactionStorage.getStore();` to the end of the method (L476-508):

```ts
    const active = this.TransactionStorage.getStore();

    // already inside a transaction — nest with a savepoint rather than opening a second one
    if (active) {
      const name = `sp_${++active.depth}`;

      await this._savepoint(active, name);

      try {
        const result = await cb(this);
        await this._releaseSavepoint(active, name);
        return result;
      } catch (err) {
        await this._rollbackToSavepoint(active, name);
        throw err;
      }
    }

    const ctx = await this._begin(options);
    ctx.depth = 0;

    try {
      const result = await this.TransactionStorage.run(ctx, () => cb(this));
      await this._commit(ctx);
      return result;
    } catch (err) {
      // swallow a rollback failure so it cannot mask whatever actually went wrong
      await this._rollback(ctx).catch(() => undefined);
      throw err;
    } finally {
      await this._dispose(ctx);
    }
  }
```

with:

```ts
    const active = this.TransactionStorage.getStore();

    // already inside a transaction — nest with a savepoint rather than opening a second one
    if (active) {
      const name = `sp_${++active.depth}`;
      // Savepoints of one transaction run one after another, so everything queued past this
      // mark was queued inside this savepoint.
      const queued = active.afterCommit?.length ?? 0;

      await this._savepoint(active, name);

      try {
        const result = await cb(this);
        await this._releaseSavepoint(active, name);
        return result;
      } catch (err) {
        active.afterCommit?.splice(queued);
        await this._rollbackToSavepoint(active, name);
        throw err;
      }
    }

    const ctx = await this._begin(options);
    ctx.depth = 0;

    let result: R;
    try {
      result = await this.TransactionStorage.run(ctx, () => cb(this));
      await this._commit(ctx);
    } catch (err) {
      // swallow a rollback failure so it cannot mask whatever actually went wrong
      await this._rollback(ctx).catch(() => undefined);
      throw err;
    } finally {
      await this._dispose(ctx);
    }

    await this._runAfterCommit(ctx.afterCommit ?? []);
    return result;
  }

  /**
   * Runs `cb` after the outermost transaction in scope commits, or at once when none is open.
   * Queued callbacks run in registration order once the connection is released, before
   * `transaction()` resolves. A rollback drops what was queued inside the part it rolls back:
   * everything for the outermost transaction, everything since the savepoint began for a
   * savepoint. A callback that throws is logged and never rethrown.
   */
  public async afterCommit(cb: () => void | Promise<void>): Promise<void> {
    const active = this.TransactionStorage.getStore();

    if (!active) {
      await this._runAfterCommit([cb]);
      return;
    }

    (active.afterCommit ??= []).push(cb);
  }

  private async _runAfterCommit(callbacks: readonly (() => void | Promise<void>)[]): Promise<void> {
    for (const cb of callbacks) {
      try {
        await cb();
      } catch (err) {
        this.Log?.error(`afterCommit callback on connection ${this.Options.Name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
```

Also extend the doc comment of `transaction()` (above L471) by one line after "rolls back only its own work.":

```ts
   * Callbacks queued with {@link afterCommit} run after the outermost commit, before this resolves.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/orm && ONE test/driver.test.ts test/query-middleware-hooks.test.ts`
Expected: PASS, `0 failing`; `OrmDriver.afterCommit ( decision 18 )` reports 7 passing tests, and the transaction contract tests above it still pass.

- [ ] **Step 6: Run the ORM suite and a dialect suite**

Run: `cd packages/orm && npm test`
Expected: `0 failing`.

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npm test`
Expected: `0 failing` (real SQLite transactions, savepoints and rollbacks go through the changed `transaction()`).

- [ ] **Step 7: Commit**

```bash
git add packages/orm/src/interfaces.ts packages/orm/src/driver.ts packages/orm/test/driver.test.ts
git commit -m "feat(orm): OrmDriver.afterCommit runs callbacks after the outermost commit and drops them on rollback"
```

---

### Task 4: raw select columns keep their bindings (`@spinajs/orm-sql`)

**Files:**
- Modify: `packages/orm-sql/src/compilers.ts:252-265` (`SqlColumnsCompiler`)
- Modify: `packages/orm-sql/src/compilers.ts:370-427` (`SqlSelectQueryCompiler.compile`, `select`)
- Test: `packages/orm-sql/test/queryBuilder.test.ts`
- Create: `packages/orm-sqlite/test/rawSelectBindings.test.ts`

**Interfaces:**
- Produces: `builder.select(RawQuery.create(sql, bindings))` compiles to `bindings` that start with the raw columns' bindings, in column order, followed by join, where, group, having, sort and limit bindings (the order of the fragments in the SQL). A sub-query (`whereExist`, …) carries them through its own `toDB()`. L4's `.withAccess()` relies on this for its `CASE WHEN … THEN 1 ELSE 0 END AS …` columns.

- [ ] **Step 1: Write the failing compiler tests**

In `packages/orm-sql/test/queryBuilder.test.ts`, after `it('select raw', …)` (L1495-1498) add:

```ts
  it('select raw keeps its bindings, ahead of the where bindings', () => {
    const result = sqb()
      .select(RawQuery.create('CASE WHEN `owner` = ? THEN 1 ELSE 0 END AS `a`', ['u1']))
      .select(RawQuery.create('CASE WHEN `team` IN (?, ?) THEN 1 ELSE 0 END AS `b`', ['t1', 't2']))
      .select('bar')
      .from('users')
      .where('email', 'spine@spine.pl')
      .toDB();

    expect(result.expression).to.equal('SELECT CASE WHEN `owner` = ? THEN 1 ELSE 0 END AS `a`,CASE WHEN `team` IN (?, ?) THEN 1 ELSE 0 END AS `b`,`bar` FROM `users` WHERE `email` = ?');
    expect(result.bindings).to.deep.equal(['u1', 't1', 't2', 'spine@spine.pl']);
  });

  it('a sub-query keeps the bindings of its raw select columns', () => {
    const sub = sqb().select(RawQuery.create('? AS `x`', ['marker'])).from('comments').where('email', 'spine@spine.pl');
    const result = sqb().select('*').from('users').whereExist(sub as ISelectQueryBuilder<ModelBase<unknown>>).toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE EXISTS ( SELECT ? AS `x` FROM `comments` WHERE `email` = ? )');
    expect(result.bindings).to.deep.equal(['marker', 'spine@spine.pl']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/orm-sql && ONE test/queryBuilder.test.ts --grep "raw select columns|select raw keeps"`
Expected: FAIL, 2 failing: `expected [ 'spine@spine.pl' ] to deeply equal [ 'u1', 't1', 't2', 'spine@spine.pl' ]` and `expected [ 'spine@spine.pl' ] to deeply equal [ 'marker', 'spine@spine.pl' ]`.

- [ ] **Step 3: Return the column bindings from the compilers**

In `packages/orm-sql/src/compilers.ts`, replace `SqlColumnsCompiler` (L252-265):

```ts
@NewInstance()
export class SqlColumnsCompiler implements IColumnsCompiler {
  public columns(builder: IColumnsBuilder) {
    return {
      bindings: [] as any[],
      expression: builder
        .getColumns()
        .map((c) => {
          return c.build().Statements[0];
        })
        .join(','),
    };
  }
}
```

with:

```ts
@NewInstance()
export class SqlColumnsCompiler implements IColumnsCompiler {
  public columns(builder: IColumnsBuilder) {
    const built = builder.getColumns().map((c) => c.build());

    return {
      bindings: built.flatMap((b) => b.Bindings ?? []),
      expression: built.map((b) => b.Statements[0]).join(','),
    };
  }
}
```

In `SqlSelectQueryCompiler.compile()` replace

```ts
    const expression = columns + ' ' + from + (join.expression ? ` ${join.expression}` : '') + (where.expression ? ` WHERE ${where.expression}` : '') + group.expression + (having.expression ? ` HAVING ${having.expression}` : '') + sort.expression + limit.expression;

    const bindings = [];
    bindings.push(...(join.bindings ?? []));
```

with

```ts
    const expression = columns.expression + ' ' + from + (join.expression ? ` ${join.expression}` : '') + (where.expression ? ` WHERE ${where.expression}` : '') + group.expression + (having.expression ? ` HAVING ${having.expression}` : '') + sort.expression + limit.expression;

    const bindings = [];
    bindings.push(...(columns.bindings ?? []));
    bindings.push(...(join.bindings ?? []));
```

and replace `select()` (L415-427):

```ts
  protected select() {
    let _stmt = 'SELECT ';

    if (this._builder.IsDistinct) {
      _stmt += 'DISTINCT ';
    }

    if (this._builder.getColumns().length === 0) {
      return _stmt + '*';
    }

    return _stmt + this.columns(this._builder).expression;
  }
```

with:

```ts
  protected select(): ICompilerOutput {
    let _stmt = 'SELECT ';

    if (this._builder.IsDistinct) {
      _stmt += 'DISTINCT ';
    }

    if (this._builder.getColumns().length === 0) {
      return { expression: _stmt + '*', bindings: [] };
    }

    const columns = this.columns(this._builder);
    return { expression: _stmt + columns.expression, bindings: columns.bindings };
  }
```

`SqlColumnRawStatement` (`packages/orm-sql/src/statements.ts:620-631`) already returns `RawQuery.Bindings` and stays unchanged.

- [ ] **Step 4: Run the compiler tests to verify they pass**

Run: `cd packages/orm-sql && ONE test/queryBuilder.test.ts`
Expected: PASS, `0 failing` (the two new tests pass; `select raw` and every other select test keep their expressions).

- [ ] **Step 5: Write the database test**

Create `packages/orm-sqlite/test/rawSelectBindings.test.ts`:

```ts
/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { RawQuery } from '@spinajs/orm';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowTag } from './uowFixture.js';

const expect = chai.expect;

describe('raw select columns with bindings on sqlite', function () {
  this.timeout(10000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('binds the value of a CASE WHEN column', async () => {
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });

    const out = (await db()
      .Connections.get('sqlite')!
      .select()
      .select(RawQuery.create('CASE WHEN Name = ? THEN 1 ELSE 0 END AS is_red', ['red']))
      .select('Name')
      .from('uow_tag')
      .asRaw<any[]>()) as { Name: string; is_red: number }[];

    expect(Object.fromEntries(out.map((r) => [r.Name, r.is_red]))).to.deep.equal({ red: 1, blue: 0 });
  });
});
```

- [ ] **Step 6: Build orm-sql and run the database test**

Run: `cd packages/orm-sql && npm run compile && cd ../orm-sqlite && ONE test/rawSelectBindings.test.ts`
Expected: PASS, `1 passing`. (Against the unfixed compiler SQLite binds nothing, reads `?` as NULL, and the test fails with `{ red: 0, blue: 0 }`.)

- [ ] **Step 7: Run the dialect suites**

Run: `cd packages/orm-sql && npm test`
Expected: `0 failing`.

Run: `cd packages/orm-sqlite && npm test`
Expected: `0 failing`.

- [ ] **Step 8: Commit**

```bash
git add packages/orm-sql/src/compilers.ts packages/orm-sql/test/queryBuilder.test.ts packages/orm-sqlite/test/rawSelectBindings.test.ts
git commit -m "fix(orm-sql): raw select columns keep their bindings"
```

---

## Contract issues found

1. **The overview's one-file test command runs everything.** Mocha 10 concatenates the `spec` of `.mocharc.json` with the files on the command line (checked with mocha 10.8.2). In `packages/orm` and `packages/orm-sqlite` the configured spec paths match nothing, so the overview's command happens to work there; in `packages/authz` it does not. This lane uses `--no-config` with the loader restated for consistency; the overview's Global Constraints should say the same.
2. **`transactional` is not consulted inside a caller's transaction.** Decision 6 says the builder wraps "when any middleware answers true and `CurrentTransaction` is undefined". This lane checks `CurrentTransaction` first, so `transactional` is not called at all inside a caller's transaction (pinned by a test). A middleware that needs to know whether its query was wrapped reads `query.Driver.CurrentTransaction` in its hooks, which is defined in both cases. No shape change.

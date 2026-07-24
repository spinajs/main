# ORM Foundation Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared groundwork the three themed ORM branches all depend on — a query builder that executes exactly once, an ORM-level transaction contract that auto-commits and cannot leak connections, and integration-test infrastructure against a real MySQL.

**Architecture:** `QueryBuilder.then()` is currently the entire execution engine: it calls the driver, transforms rows, hydrates models and runs relation middlewares inline, mutating builder state as it goes. We invert that — `execute()` becomes the engine and memoizes its promise; `then()` becomes a three-line delegate. Separately, `OrmDriver.transaction()` stops handing the caller a `commit()` they must remember to call, and instead owns the full lifecycle, with the `AsyncLocalStorage` transaction context promoted from the MySQL driver into the abstract base so every driver inherits it.

**Tech Stack:** TypeScript (ESM, dual CJS build), `@spinajs/di` for DI, mocha via `ts-mocha`, chai `expect`, sinon for spies. MySQL via `mysql2`, SQLite via `sqlite3`. Docker Compose for integration tests.

## Global Constraints

- Spec: [`docs/superpowers/specs/2026-07-25-orm-foundation-design.md`](../specs/2026-07-25-orm-foundation-design.md). Overview and cross-branch decisions: [`docs/superpowers/specs/2026-07-25-orm-overview-design.md`](../specs/2026-07-25-orm-overview-design.md).
- Breaking changes are permitted; target is a single 3.0.0 major bump (decision D1). Every behavioural change gets a changelog entry.
- Drivers in scope: MySQL and SQLite (decision D2). MSSQL must keep compiling and its suite must keep passing, but receives no new features beyond what the contract forces.
- Red-first TDD: write the failing test, run it, watch it fail for the *right reason*, then implement. Commit after each task.
- Run `npm test` in a package from that package's directory: `ts-mocha -p tsconfig.json test/**/*.test.ts`.
- Measure the baseline pass/fail counts for `orm`, `orm-sql`, `orm-sqlite` **before** touching anything. Pre-existing failures exist; the bar is "no new failures", not "all green".
- Do not touch `packages/orm/src/relation-objects.ts` or `packages/orm/src/hydrators.ts` beyond what a task explicitly requires — `orm-uow` rewrites both and gratuitous edits create merge pain.
- Already done, do not redo: B18 `clone()` (`ca91d3fb5`), B2 per-statement WHERE connector (`00a81987f`), A3 identifier escaping (`92ea0c596`).

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/orm/src/builders.ts` | `QueryBuilder.execute()` engine + `then()` delegate; `SelectQueryBuilder.execute()` first-row unwrapping | Modify (~lines 73-148, 1370-1397) |
| `packages/orm/src/interfaces.ts` | `ITransaction`, `TransactionCallback`, new `ITransactionOptions`, `IsolationLevel` | Modify |
| `packages/orm/src/driver.ts` | `OrmDriver` gains `TransactionStorage`, savepoint depth, `transaction()` template method | Modify |
| `packages/orm-mysql/src/index.ts` | Driver-specific begin/commit/rollback/savepoint primitives | Modify (~lines 255-331) |
| `packages/orm-sqlite/src/index.ts` | Same primitives for SQLite | Modify (~lines 250-283) |
| `packages/orm-mssql/src/index.ts` | Same primitives; keep compiling | Modify (~lines 215-253) |
| `docker-compose.yml` | MySQL service for integration tests | Create (repo root) |
| `packages/orm-mysql/test/integration/*.test.ts` | Integration suite against live MySQL | Create |
| `packages/orm-sqlite/test/integration/*.test.ts` | Integration suite against on-disk SQLite | Create |

---

### Task 1: Baseline measurement

**Files:** none modified.

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded baseline every later task compares against.

- [x] **Step 1: Record current pass/fail counts**

```bash
cd packages/orm     && npm test 2>&1 | tail -20
cd ../orm-sql       && npm test 2>&1 | tail -20
cd ../orm-sqlite    && npm test 2>&1 | tail -20
```

- [x] **Step 2: Write the numbers into the plan file**

Append a `## Baseline (measured YYYY-MM-DD)` section to this document recording passing/failing counts per package and the *names* of the pre-existing failures. Later tasks compare against those names, not just counts — a test that flips from failing to passing while another flips the other way keeps the count identical and hides a regression.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-25-orm-foundation.md
git commit -m "docs(orm): record test baseline for orm-foundation branch"
```

## Baseline (measured 2026-07-25)

Measured on `worktree-agent-a47d0b3b1cbe7a2ab`, forked from `orm-fixes-2` @ `be0ac3812`,
after a clean `npm install` + full `npm run build` at the repo root.

**Environment note.** Tests resolve `@spinajs/*` through the workspace symlinks into each
package's *built* `lib/mjs` output, so `packages/orm` must be rebuilt (`npm run build` in that
package, or `tsc -b tsconfig.mjs.json`) before the `orm-sql` / `orm-sqlite` suites see a source
change. `packages/orm`'s own suite imports `../src/index.js` directly and does not need this.

| Package | Passing | Failing |
| --- | --- | --- |
| `orm` | 113 | 2 |
| `orm-sql` | 146 | 7 |
| `orm-sqlite` | 43 | 8 |
| `orm-mssql` | 0 | 4 (no live SQL Server; also `this.Log.trace is not a function`) |
| `orm-mysql` | 0 | 9 (no live MySQL on `127.0.0.1:3900` — `ECONNREFUSED`) |

### Pre-existing failures by name

`orm` (2):
1. `Orm relations tests` → `OneToOneRelation should be dehydrated`
2. `Orm relations tests` → `populate should load missing relation data`

`orm-sql` (7):
1. `model generated queries` → `Should model query join work`
2. `model generated queries` → `model insert with uuid from static function`
3. `model generated queries` → `model join with select and column alias`
4. `model generated queries` → `model join with exists`
5. `model generated queries` → `whereExists on ManyToMany relation should join the target so the callback resolves`
6. `Select query builder` → `withRecursion simple`
7. `Select query builder` → `withRecursion with where`

`orm-sqlite` (8):
1. `Sqlite - relations test` → `Static method populate on oneToMany`
2. `Sqlite model functions` → `Model should populate recursive relations`
3. `Sqlite model functions` → `model should populate nested belongsTo relation`
4. `Sqlite model functions` → `model relation belongsto should populate `
5. `Sqlite model functions` → `model relation set should work`
6. `Sqlite model functions` → `model relation set should update`
7. `Sqlite model functions` → `model relation union should work`
8. `Sqlite model functions` → `model relation diff should work`

`orm-mssql` (4) — every test in `Mssql driver migrate, updates, deletions & inserts`, all
failing with `TypeError: this.Log.trace is not a function` before any DB contact.

`orm-mysql` (9) — every test in `mysql.test.ts`; all require a live MySQL on port 3900.

### Docker availability

`docker` is **not installed** on this machine (`docker`, `docker compose`, `docker info` all
absent; no `C:\Program Files\Docker`). Task 8's live-database verification cannot be run here.

---

### Task 2: `execute()` becomes the engine, `then()` becomes a delegate (F1, closes B9)

**Files:**
- Modify: `packages/orm/src/builders.ts:73-148` (`QueryBuilder.then`), `1370-1397` (`SelectQueryBuilder.then` / `execute`)
- Test: `packages/orm-sql/test/queryBuilder.test.ts`

**Interfaces:**
- Consumes: `OrmDriver.execute(builder)`, `IBuilderMiddleware<T>` (`afterQuery`, `modelCreation`, `afterHydration`), `QueryMiddleware.beforeQueryExecution`.
- Produces: `QueryBuilder.execute(): Promise<T>` — the single execution entry point, memoized. `then()` on both `QueryBuilder` and `SelectQueryBuilder` delegates to it and returns a real promise chain.

**Why this is a bug, not a refactor.** The current `then()` invokes `onfulfilled?.(result)` for its side effect and then `return;` on several branches (builders.ts:78-79 among others), so the value a caller returns from `.then(cb)` is discarded. That is B9. Chained `.then()` calls silently produce `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
it('then() propagates the callback return value down the chain (B9)', async () => {
  const result = await sqb()
    .select('*')
    .from('users')
    .then((rows: any) => 'transformed');

  expect(result).to.equal('transformed');
});

it('execute() runs the query once no matter how many times it is awaited', async () => {
  const query = sqb().select('*').from('users');
  const spy = sinon.spy(query.Driver, 'execute');

  await query;
  await query;
  await query.execute();

  expect(spy.calledOnce).to.be.true;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/orm-sql && npx ts-mocha -p tsconfig.json test/queryBuilder.test.ts -g "B9|executes the query once"`
Expected: first test FAILS with `expected undefined to equal 'transformed'`; second FAILS with the driver called three times.

- [ ] **Step 3: Extract the engine into `execute()`**

Move the whole body of `QueryBuilder.then()` into `protected async _run(): Promise<T>`, then:

```ts
protected _executionPromise: Promise<T> | null = null;

public execute(): Promise<T> {
  if (!this._executionPromise) {
    this._executionPromise = this._run();
  }
  return this._executionPromise;
}

public then<TResult1 = T, TResult2 = never>(
  onfulfilled?: (value: T) => TResult1 | PromiseLike<TResult1>,
  onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>,
): PromiseLike<TResult1 | TResult2> {
  return this.execute().then(onfulfilled, onrejected);
}
```

`_run()` must `return` its values rather than calling `onfulfilled` for effect — the callback plumbing disappears entirely, because the native promise chain now does that job. Drop the manual `catch`/`onrejected` forwarding for the same reason.

- [ ] **Step 4: Rework `SelectQueryBuilder`**

`SelectQueryBuilder.then()` (line 1370) currently overrides `then` to apply `_first` unwrapping and to fire `_queryMiddlewares.beforeQueryExecution`. Both move into an `execute()` override:

```ts
public async execute(): Promise<T> {
  this._queryMiddlewares.forEach((x) => x.beforeQueryExecution(this));
  const result = await super.execute();
  if (this._first && Array.isArray(result)) {
    return (result.length !== 0 ? result[0] : undefined) as T;
  }
  return result;
}
```

Delete the `then()` override — the inherited delegate is now correct. Keep `all()` and `resultExists()`; retarget them at `execute()`.

Note `beforeQueryExecution` now runs inside the memo, so it fires once per builder rather than once per await. That is the intended fix, not a side effect.

- [ ] **Step 5: Run the tests**

Run: `cd packages/orm-sql && npm test`
Expected: the two new tests PASS; no failures beyond the Task 1 baseline names.

- [ ] **Step 6: Run the dependent suites**

```bash
cd packages/orm && npm test
cd ../orm-sqlite && npm test
```
Expected: no new failures. `first()`, `firstOrFail()`, `orThrow()` and `resultExists()` all route through the changed code — if any break, the `_first` unwrapping moved to the wrong place.

- [ ] **Step 7: Commit**

```bash
git add packages/orm/src/builders.ts packages/orm-sql/test/queryBuilder.test.ts
git commit -m "fix(orm): execute-once query builder, then() delegates (F1, B9)"
```

---

### Task 3: Immutable middleware pipeline (F1, closes B8 and B19)

**Files:**
- Modify: `packages/orm/src/builders.ts` (the `_run()` body from Task 2)
- Test: `packages/orm-sql/test/queryBuilder.test.ts`

**Interfaces:**
- Consumes: `QueryBuilder._run()` from Task 2.
- Produces: no new public API. `_middlewares` is never mutated during execution.

**The bug.** `for (const middleware of this._middlewares.reverse())` reverses the array **in place**. `Array.prototype.reverse` mutates. Every execution flips middleware order, so `modelCreation` resolution order alternates between runs. Combined with `mergeRelations()` concatenating middleware arrays across builders, this is B8.

- [ ] **Step 1: Write the failing test**

```ts
it('does not mutate the middleware array during execution (B8)', async () => {
  const query = sqb().select('*').from('users');
  const a = fakeMiddleware('a');
  const b = fakeMiddleware('b');
  query.middleware(a);
  query.middleware(b);

  const before = [...(query as any)._middlewares];
  await query.execute();

  expect((query as any)._middlewares).to.deep.equal(before);
});

it('toDB() is idempotent (B19)', () => {
  const query = sqb().select('*').from('users').where('a', 1);
  const first = query.toDB();
  const second = query.toDB();

  expect(second).to.deep.equal(first);
});
```

`fakeMiddleware(name)` returns an object implementing `IBuilderMiddleware` whose `modelCreation` returns `null`, `afterQuery` returns its argument unchanged, and `afterHydration` resolves. Add it to the test file's helpers if no equivalent exists.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/orm-sql && npx ts-mocha -p tsconfig.json test/queryBuilder.test.ts -g "B8|B19"`
Expected: the B8 test FAILS showing the array reversed.

- [ ] **Step 3: Snapshot the pipeline per execution**

At the top of `_run()`, take one immutable copy and use it throughout:

```ts
const middlewares = [...this._middlewares];
const creationOrder = [...middlewares].reverse();
```

Use `middlewares` for `afterQuery` and `afterHydration`, `creationOrder` for the `modelCreation` loop. Never call `.reverse()` on `this._middlewares`.

- [ ] **Step 4: Make `toDB()` side-effect free**

Audit `toDB()` and everything it calls for state mutation on the builder — appending to `_statements`, resolving relations, registering middlewares. Compilation must read builder state, not modify it. If a mutation is genuinely required (relation compilation), hoist it into `_run()` before compilation so it happens once per execution rather than once per `toDB()` call.

- [ ] **Step 5: Run the tests**

Run: `cd packages/orm-sql && npm test && cd ../orm && npm test`
Expected: both new tests PASS, no new failures.

- [ ] **Step 6: Commit**

```bash
git add packages/orm/src/builders.ts packages/orm-sql/test/queryBuilder.test.ts
git commit -m "fix(orm): immutable middleware pipeline per execution (F1, B8, B19)"
```

---

### Task 4: Transaction contract on the abstract driver (F2, part 1)

**Files:**
- Modify: `packages/orm/src/interfaces.ts`, `packages/orm/src/driver.ts`
- Test: `packages/orm/test/driver.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface ITransactionOptions {
  isolation?: IsolationLevel;
}

/**
 * Per-transaction state carried through AsyncLocalStorage. `connection` is the
 * driver's own connection handle type and is absent for drivers with a single
 * shared handle (SQLite). `depth` counts nested savepoints, 0 at the outermost.
 */
export interface ITransactionContext {
  connection?: unknown;
  depth: number;
}

/** Existing `TransactionCallback` becomes generic in its return type. */
export type TransactionCallback<R = void> = (driver: OrmDriver) => Promise<R>;

// OrmDriver, new members:
//   protected TransactionStorage: AsyncLocalStorage<ITransactionContext>
//   public readonly SupportedIsolationLevels: IsolationLevel[]   // per-driver, defaults to []
//   protected abstract _begin(options?: ITransactionOptions): Promise<ITransactionContext>
//   protected abstract _commit(ctx: ITransactionContext): Promise<void>
//   protected abstract _rollback(ctx: ITransactionContext): Promise<void>
//   protected abstract _savepoint(ctx: ITransactionContext, name: string): Promise<void>
//   protected abstract _releaseSavepoint(ctx: ITransactionContext, name: string): Promise<void>
//   protected abstract _rollbackToSavepoint(ctx: ITransactionContext, name: string): Promise<void>
//   protected abstract _dispose(ctx: ITransactionContext): Promise<void>
//   public transaction<R>(cb: TransactionCallback<R>, options?: ITransactionOptions): Promise<R>
```

**The bug (B24).** Every driver's `transaction()` today runs the callback and then *resolves with* `{ commit, rollback }` for the caller to invoke. Nothing commits unless the caller remembers, and nothing releases the pooled connection if they don't. The callback form must own the whole lifecycle.

- [ ] **Step 1: Write the failing test**

Use a fake driver subclassing `OrmDriver` that records primitive calls into an array.

```ts
it('commits when the callback resolves', async () => {
  const d = new FakeTxDriver();
  const r = await d.transaction(async () => 'value');
  expect(r).to.equal('value');
  expect(d.calls).to.deep.equal(['begin', 'commit', 'dispose']);
});

it('rolls back and rethrows when the callback throws', async () => {
  const d = new FakeTxDriver();
  await expect(d.transaction(async () => { throw new Error('boom'); })).to.be.rejectedWith('boom');
  expect(d.calls).to.deep.equal(['begin', 'rollback', 'dispose']);
});

it('disposes the connection exactly once even when commit fails', async () => {
  const d = new FakeTxDriver({ failCommit: true });
  await expect(d.transaction(async () => 1)).to.be.rejected;
  expect(d.calls.filter((c) => c === 'dispose')).to.have.length(1);
});

it('nests via savepoints', async () => {
  const d = new FakeTxDriver();
  await d.transaction(async () => {
    await d.transaction(async () => 'inner');
  });
  expect(d.calls).to.deep.equal(['begin', 'savepoint', 'releaseSavepoint', 'commit', 'dispose']);
});

it('rejects an isolation level the driver does not support', async () => {
  const d = new FakeTxDriver({ supported: ['READ COMMITTED'] });
  await expect(d.transaction(async () => 1, { isolation: 'SERIALIZABLE' })).to.be.rejected;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/driver.test.ts`
Expected: FAIL — `_begin` and friends do not exist.

- [ ] **Step 3: Implement the template method on `OrmDriver`**

```ts
public async transaction<R>(cb: TransactionCallback<R>, options?: ITransactionOptions): Promise<R> {
  const active = this.TransactionStorage.getStore();

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

  if (options?.isolation && !this.SupportedIsolationLevels.includes(options.isolation)) {
    throw new OrmException(`isolation level ${options.isolation} not supported by this driver`);
  }

  const ctx = await this._begin(options);
  ctx.depth = 0;
  try {
    const result = await this.TransactionStorage.run(ctx, () => cb(this));
    await this._commit(ctx);
    return result;
  } catch (err) {
    await this._rollback(ctx).catch(() => undefined);
    throw err;
  } finally {
    await this._dispose(ctx);
  }
}
```

Note `_dispose` in `finally` so the connection is released on every path exactly once, and `_rollback` swallowing its own error so a rollback failure cannot mask the original.

- [ ] **Step 4: Run the tests**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/driver.test.ts`
Expected: all five PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src/driver.ts packages/orm/src/interfaces.ts packages/orm/test/driver.test.ts
git commit -m "feat(orm): ORM-level transaction contract with auto-commit and savepoints (F2, B24)"
```

---

### Task 5: MySQL driver implements the primitives

**Files:**
- Modify: `packages/orm-mysql/src/index.ts:255-331`
- Test: `packages/orm-mysql/test/integration/transaction.test.ts` (created in Task 8; write the unit-level parts here against a stubbed pool)

**Interfaces:**
- Consumes: the abstract members from Task 4.
- Produces: `_begin`/`_commit`/`_rollback`/`_savepoint`/`_releaseSavepoint`/`_rollbackToSavepoint`/`_dispose` on the MySQL driver; `SupportedIsolationLevels` listing all four.

- [ ] **Step 1: Delete the old `transaction()` override**

The base class now owns the flow. Everything from `public transaction(queryOrCallback?...)` through its closing brace goes.

- [ ] **Step 2: Implement the primitives**

`_begin` acquires a pooled connection (promisify `Pool.getConnection`), issues `SET TRANSACTION ISOLATION LEVEL ...` when `options.isolation` is set, then `connection.beginTransaction()`, and returns `{ connection, depth: 0 }`. `_commit`/`_rollback` call the mysql2 equivalents. The three savepoint primitives issue `SAVEPOINT ?` / `RELEASE SAVEPOINT ?` / `ROLLBACK TO SAVEPOINT ?` as literal SQL with the name inlined through the escaping helper from `92ea0c596` — savepoint names cannot be bound parameters. `_dispose` calls `connection.release()`.

The existing `TransactionStorage` field on this driver is deleted; `executeOnDb` keeps reading `this.TransactionStorage.getStore()`, which now resolves to the inherited one.

- [ ] **Step 3: Verify the ambient-context path still works**

`executeOnDb` picks `txContext?.connection ?? this.Pool`. Confirm the context shape is unchanged so that line needs no edit.

- [ ] **Step 4: Build and run**

```bash
cd packages/orm-mysql && npm run build && npm test
```
Expected: compiles; unit suite passes. Live-DB verification comes in Task 8.

- [ ] **Step 5: Commit**

```bash
git add packages/orm-mysql/src/index.ts
git commit -m "feat(orm-mysql): implement transaction primitives against the driver contract"
```

---

### Task 6: SQLite driver implements the primitives

**Files:**
- Modify: `packages/orm-sqlite/src/index.ts:250-283`

**Interfaces:**
- Consumes: Task 4's abstract members.
- Produces: the same seven primitives for SQLite.

- [ ] **Step 1: Replace `transaction()` with primitives**

SQLite has one shared handle, so the context carries no connection — `_begin` issues `BEGIN TRANSACTION` and returns `{ depth: 0 }`. Savepoints work natively: `SAVEPOINT sp_1` / `RELEASE sp_1` / `ROLLBACK TO sp_1`.

`SupportedIsolationLevels` is `['SERIALIZABLE']` only — sqlite3 outside shared-cache mode gives serialized access and nothing else. Any other requested level must be rejected by the base class rather than silently ignored, which is exactly what Task 4's check does.

- [ ] **Step 2: Run the suite**

Run: `cd packages/orm-sqlite && npm test`
Expected: no new failures against baseline.

- [ ] **Step 3: Commit**

```bash
git add packages/orm-sqlite/src/index.ts
git commit -m "feat(orm-sqlite): implement transaction primitives against the driver contract"
```

---

### Task 7: MSSQL driver keeps compiling

**Files:**
- Modify: `packages/orm-mssql/src/index.ts:215-253`

**Interfaces:**
- Consumes: Task 4's abstract members.
- Produces: the same seven primitives, mapped onto the `mssql` package's `Transaction` object.

MSSQL is out of investment scope but the contract is abstract, so it must implement the primitives or the package will not compile.

- [ ] **Step 1: Map the primitives onto `mssql`**

`_begin` → `connectionPool.transaction()` + `transaction.begin(isolationLevel)`. `_commit`/`_rollback` → the `Transaction` methods. Savepoints → `SAVE TRANSACTION <name>` and `ROLLBACK TRANSACTION <name>`; MSSQL has no release, so `_releaseSavepoint` is a resolved no-op with a comment saying why. `_dispose` is a no-op — `mssql` manages its own pooling.

- [ ] **Step 2: Build**

Run: `cd packages/orm-mssql && npm run build && npm test`
Expected: compiles, suite passes.

- [ ] **Step 3: Commit**

```bash
git add packages/orm-mssql/src/index.ts
git commit -m "feat(orm-mssql): implement transaction primitives to satisfy the driver contract"
```

---

### Task 8: Integration test infrastructure (F5)

**Files:**
- Create: `docker-compose.yml`, `packages/orm-mysql/test/integration/transaction.test.ts`, `packages/orm-sqlite/test/integration/transaction.test.ts`
- Modify: `packages/orm-mysql/package.json`, `packages/orm-sqlite/package.json` (add `test:integration`)

**Interfaces:**
- Consumes: the transaction contract from Tasks 4-6.
- Produces: `docker compose up -d mysql` plus `npm run test:integration`, which `orm-perf` later builds its benchmark harness on.

- [ ] **Step 1: Write `docker-compose.yml`**

One `mysql:8` service on a non-default host port to avoid colliding with a local install, with a healthcheck and a named volume. Put it behind a compose profile so `docker compose up` without arguments does not start it.

- [ ] **Step 2: Add the test scripts**

`"test:integration": "ts-mocha -p tsconfig.json test/integration/**/*.test.ts"` in both packages. The existing `test` script must keep matching only `test/**/*.test.ts` at the top level, or CI without Docker will start failing — verify the glob does not pick up `test/integration/`. If it does, move the unit specs or tighten the glob.

- [ ] **Step 3: Write the integration tests**

Against a real database, asserting what the fakes cannot:

```ts
it('commits on success', async () => {
  await driver.transaction(async () => { await Model.insert({ Name: 'a' }); });
  expect(await Model.count()).to.equal(1);
});

it('rolls back on throw', async () => {
  await expect(driver.transaction(async () => {
    await Model.insert({ Name: 'a' });
    throw new Error('boom');
  })).to.be.rejected;
  expect(await Model.count()).to.equal(0);
});

it('inner savepoint rolls back without discarding the outer transaction', async () => {
  await driver.transaction(async () => {
    await Model.insert({ Name: 'outer' });
    await driver.transaction(async () => {
      await Model.insert({ Name: 'inner' });
      throw new Error('inner fails');
    }).catch(() => undefined);
  });
  const rows = await Model.all();
  expect(rows.map((r) => r.Name)).to.deep.equal(['outer']);
});

it('releases the pooled connection', async () => {
  for (let i = 0; i < 50; i++) {
    await driver.transaction(async () => { await Model.count(); });
  }
  // pool limit is well under 50; if connections leaked this would have hung already
});
```

The connection-release test is the one that actually proves B24 is fixed — set `PoolLimit` to something small like 2 so a leak deadlocks rather than passing quietly.

- [ ] **Step 4: Run against MySQL and SQLite**

```bash
docker compose --profile test up -d mysql
cd packages/orm-mysql  && npm run test:integration
cd ../orm-sqlite       && npm run test:integration
```
Expected: PASS on both.

- [ ] **Step 5: Document it**

A short `## Running integration tests` section in the repo README: start the container, set the env vars, run the script.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml packages/orm-mysql packages/orm-sqlite README.md
git commit -m "test(orm): docker MySQL and integration suites for the transaction contract (F5)"
```

---

### Task 9: Consumers, changelog, self-review

**Files:**
- Modify: consumers as needed; `docs/orm-analysis.md` (changelog section)

**Interfaces:**
- Consumes: everything above.
- Produces: a merge-ready branch.

- [ ] **Step 1: Find every caller of the old transaction API**

```bash
grep -rn "\.transaction(" packages --include=*.ts | grep -v node_modules
```
Any caller that awaits `transaction(...)` and then calls `.commit()` must drop the `commit()` call — the base class now commits. Any caller passing an array of builders instead of a callback needs converting, since the array form is gone.

- [ ] **Step 2: Build the dependent packages**

```bash
cd packages/orm-api && npm run build
cd ../orm-http && npm run build && npm test
cd ../intl-orm && npm run build && npm test
cd ../queue-orm-transport && npm run build && npm test
cd ../orm-threading && npm run build && npm test
```
`intl-orm` hooks the middleware pipeline directly and is the most likely casualty of Task 3 — run its suite, do not settle for a clean compile.

- [ ] **Step 3: Write the changelog**

Append an `orm-foundation` section to `docs/orm-analysis.md` covering: re-awaiting a builder no longer re-executes (call `.clone()` if you need a fresh run); `transaction(cb)` now commits automatically and the returned value is the callback's result rather than an `ITransaction`; the array-of-builders form is removed; nested `transaction()` calls now create savepoints instead of independent transactions.

- [ ] **Step 4: Self-review against the spec**

Re-read [the foundation spec](../specs/2026-07-25-orm-foundation-design.md) section by section. F1, F2, F5 each need a task pointing at them. F3 and F4 are already landed — confirm nothing regressed them. Note anything deferred, with the reason.

- [ ] **Step 5: Full suite**

```bash
cd packages/orm && npm test && cd ../orm-sql && npm test && cd ../orm-sqlite && npm test
```
Expected: no failures beyond the Task 1 baseline names.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(orm): orm-foundation changelog and consumer updates"
```

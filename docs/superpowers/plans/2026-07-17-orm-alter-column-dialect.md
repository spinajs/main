# ORM Alter-Column Dialect Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ALTER TABLE ... ADD/MODIFY/RENAME COLUMN` emit dialect-correct SQL on every driver, then use it to widen `queue_jobs.Status` to the six values the code already writes.

**Architecture:** The alter path renders column bodies via class inheritance (`super.compile()`), statically binding to `orm-sql`'s MySQL dialect, while the CREATE TABLE path resolves `ColumnQueryCompiler` from the DI container (late binding). Replace inheritance with composition in `orm-sql`, extract the dialect verbs into overridable hooks, then add small per-driver subclasses. The DI seam already exists — `SqlAlterTableQueryCompiler` already resolves `AlterColumnQueryCompiler` from the container, so no driver-registration plumbing is needed.

**Tech Stack:** TypeScript (ESM, `node16`), lerna monorepo with tsc project references, ts-mocha + chai.

## Global Constraints

- **MySQL output must be byte-identical after Task 1.** `orm-mysql` registers no column compiler, so the container yields `SqlColumnQueryCompiler` — the same class `super.compile()` reaches today. The existing assertion in `packages/orm-sql/test/queryBuilder.test.ts:1399` (``ALTER TABLE `test` MODIFY `Id2` VARCHAR(255)``) must keep passing **unchanged**. If it needs editing, something is wrong — stop and report.
- **Absolute green is NOT the signal — this repo has ~34 pre-existing failures.** Known baselines: `orm-sql` **119 passing / 7 failing**, `orm-sqlite` **41 passing / 8 failing**, `orm` 89/2. **Always baseline-diff**: run the suite at HEAD before your change, keep the numbers, compare after. A count that matches the baseline is success.
- **SQLite `.modify()` is a logged no-op** (decision A′). Warn loudly, naming the column and what was skipped. Do NOT throw — a throw would break portable widening migrations that merely *restate* constraints (see Task 4).
- **MSSQL ships inspection-only.** No server available; assert compiled SQL strings, do not claim execution.
- **No breaking changes to public API.** `AlterColumnQueryCompiler.compile()` keeps returning a single `ICompilerOutput`.
- **Package versions:** internal `@spinajs/*` deps are pinned to `2.0.481`.
- **Commit style:** conventional commits.
- **Branch:** `feat/templates-fs-injection`. Do not create branches, merge, or push.
- **`npm run build` ALONE leaves a package broken**: `clean` rimrafs both `lib/mjs` and `lib/cjs`, but `compile` only rebuilds mjs. Always `npm run build && npm run compile:cjs`. Workspace `@spinajs/*` imports resolve to compiled `lib/` — rebuild a package or downstream suites silently test stale code. **Never run the root `npm run build`.**

## Key facts (established by investigation — trust these, verify if cheap)

- `SqlAlterTableQueryCompiler.compile()` (`orm-sql/src/compilers.ts:663-674`) **already** does `this.container.resolve(AlterColumnQueryCompiler, [c])` — the seam works; a driver's registration would be honored today.
- `SqlAlterColumnQueryCompiler` (`orm-sql/src/compilers.ts:1022-1055`) `extends SqlColumnQueryCompiler` and calls `super.compile()` at `:1038`. **Two dialect leaks**: the verb (`MODIFY` at `:1049`, `RENAME COLUMN` at `:1034`, `AFTER` at `:1042` — all MySQL-only) and the body (`ENUM`/`VARCHAR`/backticks from `_statementsMappings` at `:917-957`).
- Driver registrations: `orm-sqlite/src/index.ts:237-238` and `orm-mssql/src/index.ts:159-160` each register their own `ColumnQueryCompiler` + `TableQueryCompiler`. **`orm-mysql` registers neither** — `orm-sql` *is* the MySQL dialect.
- **`.modify()` has ZERO production callers** repo-wide; the only call site is the string assertion at `orm-sql/test/queryBuilder.test.ts:1394`. Blast radius is near-nil.
- The ADD path uses the **same** compiler; it works only by coincidence of universal `ADD <col> <type>` syntax.
- `orm-sql/test/queryBuilder.test.ts`'s `schqb()` helper pulls a connection named `'sqlite'` that is a **fake driver from `orm-sql/test/fixture.ts`** registering `orm-sql`'s own compilers. **It asserts MySQL output under a SQLite label** — it cannot catch dialect bugs. Do not add dialect assertions there; add them in each driver's own suite.
- `orm-sqlite`'s suite runs fully **in-memory** (`Filename: ':memory:'`) — the only place a fix gets real execution coverage.

---

### Task 1: `orm-sql` — composition + dialect hooks + skip empty outputs

**Files:**
- Modify: `packages/orm-sql/src/compilers.ts` (`SqlAlterColumnQueryCompiler` at :1022-1055; `SqlAlterTableQueryCompiler.compile()` at :663-674)
- Test: `packages/orm-sql/test/queryBuilder.test.ts` (existing assertions must pass UNCHANGED)

**Interfaces:**
- Consumes: `ColumnQueryCompiler` token from `@spinajs/orm`; `Container` from `@spinajs/di`.
- Produces — the hook surface Tasks 2 and 3 override:
  - `protected _columnDefinition(): ICompilerOutput` — resolves `ColumnQueryCompiler` from the container for the builder (late-bound to the driver).
  - `protected _add(def: string): string` — default `` `ADD ${def} ${AfterColumn ? `AFTER \`x\`` : ''}` ``
  - `protected _modify(def: string): string | null` — default `` `MODIFY ${def}` ``. **Returning `null` means "emit nothing"** (Task 2 needs this).
  - `protected _rename(): string` — default `RENAME COLUMN`.

- [ ] **Step 1: Establish the baseline — do not skip**

Run: `cd packages/orm-sql && npm test`
Record the exact counts. Expected: **119 passing, 7 failing**. If different, note the real numbers and use those as YOUR baseline.

- [ ] **Step 2: Write the failing test**

The existing suite cannot catch dialect bugs (its `'sqlite'` connection is a fake registering `orm-sql`'s own compilers), so the honest test here is that **MySQL output is unchanged** plus that an empty modify emits nothing. Append to `packages/orm-sql/test/queryBuilder.test.ts` near the other alter tests (~:1394):

```ts
  it('Should skip alter column that compiles to nothing', () => {
    // a compiler whose _modify returns null must produce no statement at all,
    // not a dangling "ALTER TABLE `test`"
    const result = schqb()
      .alterTable('test', (table) => {
        table.string('Id2', 255).modify();
      })
      .toDB();

    expect(result.every((r) => r.expression.trim().length > 0)).to.be.true;
    expect(result.every((r) => !/^ALTER TABLE `\w+`\s*$/.test(r.expression))).to.be.true;
  });
```

- [ ] **Step 3: Run it — it should PASS already**

Run: `cd packages/orm-sql && npx ts-mocha -p tsconfig.json test/queryBuilder.test.ts -g "compiles to nothing"`
Expected: PASS. This is a **guard test**, pinning behavior you must not break in Step 4. That is legitimate: Step 4 introduces the `null` path, and this proves the parent filters it.

- [ ] **Step 4: Refactor to composition with hooks**

Replace `SqlAlterColumnQueryCompiler` (`:1022-1055`). It must NO LONGER `extend SqlColumnQueryCompiler`. Read the current class and `SqlTableQueryCompiler` (`:863`) first — the latter already uses the `@Inject(Container)` + positional-builder constructor shape you need; copy that pattern exactly.

Shape (adapt names/imports to the file's real conventions):

```ts
@NewInstance()
@Inject(Container)
export class SqlAlterColumnQueryCompiler extends AlterColumnQueryCompiler {
  constructor(protected container: Container, protected builder: AlterColumnQueryBuilder) {
    super();
    if (!builder) {
      throw new InvalidArgument('builder cannot be null or undefined');
    }
  }

  /**
   * Late-bound: resolves the DRIVER's column compiler, not orm-sql's.
   * This is what CREATE TABLE has always done (see SqlTableQueryCompiler._columns).
   */
  protected _columnDefinition(): ICompilerOutput {
    return this.container.resolve<ColumnQueryCompiler>(ColumnQueryCompiler, [this.builder]).compile();
  }

  protected _add(definition: string): string | null {
    return `ADD ${definition} ${this.builder.AfterColumn ? `AFTER \`${this.builder.AfterColumn}\`` : ''}`;
  }

  protected _modify(definition: string): string | null {
    return `MODIFY ${definition}`;
  }

  protected _rename(): string | null {
    return `RENAME COLUMN \`${this.builder.OldName}\` TO \`${this.builder.Name}\``;
  }

  public compile(): ICompilerOutput {
    const cDefinition = this._columnDefinition();
    let expression: string | null;

    switch (this.builder.AlterType) {
      case ColumnAlterationType.Add:
        expression = this._add(cDefinition.expression);
        break;
      case ColumnAlterationType.Modify:
        expression = this._modify(cDefinition.expression);
        break;
      case ColumnAlterationType.Rename:
        expression = this._rename();
        break;
      default:
        expression = cDefinition.expression;
    }

    return { bindings: cDefinition.bindings, expression: expression ?? '' };
  }
}
```

**Read the real `:1022-1055` and match its actual rename/add semantics** — the sketch above may not reproduce them exactly. Preserve current MySQL behavior verbatim; you are moving code, not redesigning it.

- [ ] **Step 5: Make the parent skip empty outputs**

In `SqlAlterTableQueryCompiler.compile()` (`:663-674`), the column results are unconditionally prefixed:

```ts
expression: `${_table} ${compiler.expression}`,
```

An empty expression yields a dangling ``ALTER TABLE `x` `` — invalid SQL. Filter columns whose compiled expression is empty/whitespace **before** mapping them into outputs, so a no-op emits zero statements rather than a broken one. Task 2 depends on this.

- [ ] **Step 6: Verify MySQL is byte-identical**

Run: `cd packages/orm-sql && npm test`
Expected: **the same counts as your Step 1 baseline** (119/7 unless it differed). Critically, `Should modify column` at `:1394` must pass **without edits** — it asserts ``ALTER TABLE `test` MODIFY `Id2` VARCHAR(255)``. If it fails, your refactor changed MySQL output. Fix the refactor, not the test.

- [ ] **Step 7: Rebuild and commit**

```bash
cd packages/orm-sql && npm run build && npm run compile:cjs
cd ../..
git add packages/orm-sql/src/compilers.ts packages/orm-sql/test/queryBuilder.test.ts
git commit -m "refactor(orm-sql): resolve column compiler from container on alter path

The alter path rendered column bodies via super.compile(), statically
binding to orm-sql's MySQL dialect, while CREATE TABLE resolves
ColumnQueryCompiler from the container. Every driver therefore got MySQL
SQL for ADD/MODIFY/RENAME COLUMN.

Replace inheritance with composition so the driver's own column compiler
is late-bound, and extract the dialect verbs into overridable hooks. A
hook returning null now emits no statement at all, so a driver can
legitimately skip an alteration. MySQL output is unchanged."
```

---

### Task 2: `orm-sqlite` — no-op modify, ADD-context guard

**Files:**
- Create: `packages/orm-sqlite/src/compilers.ts` additions (or a new class in that file — follow its layout)
- Modify: `packages/orm-sqlite/src/index.ts` (registration, near :237-238)
- Test: `packages/orm-sqlite/test/` (its suite is in-memory — the only place this executes)

**Interfaces:**
- Consumes: `_columnDefinition()`, `_add()`, `_modify()`, `_rename()` from Task 1.
- Produces: `SqliteAlterColumnQueryCompiler`, registered `.as(AlterColumnQueryCompiler)`.

- [ ] **Step 1: Establish the baseline**

Run: `cd packages/orm-sqlite && npm test`. Record exact counts. Expected: **41 passing, 8 failing**. Use YOUR observed numbers as the baseline.

- [ ] **Step 2: Write the failing test**

Read the suite's existing config/bootstrap first (`test/common.ts`, `Filename: ':memory:'`) and follow its idiom. Add a test file or extend an existing one:

```ts
  it('modify column should be a no-op on sqlite', async () => {
    // sqlite renders enum as unconstrained TEXT and cannot MODIFY a column type;
    // the alter must emit nothing rather than invalid SQL
    const result = schqb()
      .alterTable('test_table', (table) => {
        table.enum('Status', ['a', 'b', 'c']).notNull().default().value('a').modify();
      })
      .toDB();

    expect(result.filter((r) => /MODIFY/i.test(r.expression))).to.be.empty;
  });

  it('add column should not emit MySQL AFTER clause on sqlite', async () => {
    const result = schqb()
      .alterTable('test_table', (table) => {
        table.int('NewCol').after('Id');
      })
      .toDB();

    expect(result.every((r) => !/AFTER/i.test(r.expression))).to.be.true;
  });
```

You will need a `schqb()`-style helper resolving `SchemaQueryBuilder` from the **real sqlite connection's** container — mirror `orm-sql/test/queryBuilder.test.ts:31-34` but point it at this package's actual connection. **Verify it resolves the real `SqliteColumnCompiler`**, not `orm-sql`'s — that mistake is exactly what made the existing orm-sql suite useless.

**Then go further — actually execute it.** The in-memory driver is available; a string assertion alone repeats the existing suite's mistake. Add a test that creates a table, runs the alter through the real driver, and asserts it does not throw:

```ts
  it('modify column should not throw against real sqlite', async () => {
    // exercise the real driver end-to-end, not just the compiler
    // (create a table, alter it, assert no throw)
  });
```

Fill that in against the suite's real bootstrap.

- [ ] **Step 3: Run — verify it fails for the right reason**

Run: `cd packages/orm-sqlite && npm test`
Expected: your new tests FAIL — the no-op test sees a `MODIFY` statement; the execution test throws `SQLITE_ERROR: near "MODIFY": syntax error`. That error is the bug, reproduced.

- [ ] **Step 4: Implement**

```ts
@NewInstance()
@Inject(Container)
export class SqliteAlterColumnQueryCompiler extends SqlAlterColumnQueryCompiler {
  /**
   * SQLite cannot change a column's type: it has no MODIFY / ALTER COLUMN.
   * It is also dynamically typed and renders enum/string/date as unconstrained
   * TEXT, so a type-only change is a semantic no-op here anyway.
   *
   * Constraint changes (NOT NULL / DEFAULT / UNIQUE) ARE enforced by sqlite and
   * are NOT applied - they need an explicit table-rebuild migration. Warn rather
   * than throw: portable migrations legitimately restate existing constraints
   * (MySQL's MODIFY requires the full definition), and throwing would break them.
   */
  protected _modify(_definition: string): string | null {
    this.Log.warn(`sqlite cannot MODIFY column '${this.builder.Name}' - skipping. Type changes are a no-op (sqlite is dynamically typed); any NOT NULL / DEFAULT / UNIQUE change was NOT applied. Write an explicit table-rebuild migration if you need one.`);
    return null;
  }

  protected _add(definition: string): string | null {
    // AFTER is MySQL-only; sqlite rejects it
    return `ADD ${definition}`;
  }
}
```

Register it in `packages/orm-sqlite/src/index.ts` alongside the existing compiler registrations (~:237-238):

```ts
this.Container.register(SqliteAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
```

Use whatever logger the surrounding classes use — read the file; do not invent a `Log` property if the base doesn't have one (fall back to `@Logger()` from `@spinajs/log` following the package's convention, or `InternalLogger`).

**THE TRAP — read this before you finish.** Task 1 makes the ADD path use `SqliteColumnCompiler` for the column body. That compiler bakes **CREATE-TABLE-only syntax** into the body: `PRIMARY KEY` (`orm-sqlite/src/compilers.ts:211-213`), `AUTOINCREMENT` (`:214-216`), and boolean → `` BOOLEAN NOT NULL CHECK (\`x\` IN (0,1)) `` (`:189`). **These are illegal inside `ADD COLUMN`.** Before Task 1, ADD emitted MySQL that SQLite happened to tolerate; now it emits SQLite syntax that may be *newly* invalid for boolean/PK adds.

Investigate whether this is reachable — add a test that ADDs a boolean column through the real in-memory driver. If it throws, add a context guard so the ADD path suppresses CREATE-only clauses, and cover it with a test. **If you cannot make ADD safe without a larger change, STOP and report** rather than shipping a regression: ADD currently works and is used by a real production migration.

- [ ] **Step 5: Verify**

Run: `cd packages/orm-sqlite && npm test`
Expected: your new tests pass; total = your Step 1 baseline + your new tests, with **the same 8 pre-existing failures**. If a previously-passing test now fails, that is a regression — diagnose it, do not accept it.

- [ ] **Step 6: Rebuild and commit**

```bash
cd packages/orm-sqlite && npm run build && npm run compile:cjs
cd ../..
git add packages/orm-sqlite/src packages/orm-sqlite/test
git commit -m "fix(orm-sqlite): emit sqlite-correct alter column SQL

sqlite got MySQL's MODIFY / AFTER syntax on the alter path, which it
rejects outright. Modify is now a logged no-op: sqlite cannot change a
column type and, being dynamically typed with enum rendered as
unconstrained TEXT, a type-only change means nothing there. Constraint
changes are warned about rather than applied - they need an explicit
table rebuild - and warned rather than thrown, because portable
migrations must restate constraints for MySQL's benefit."
```

---

### Task 3: `orm-mssql` — DEFERRED (decision C, 2026-07-17)

**Not implemented.** Investigation (agent, `orm-task-3-report.md`) found the `_rename()` hook
cannot emit `EXEC sp_rename '<table>.<old>', ...` because the table name is unreachable at
the column-compiler level: `AlterColumnQueryBuilder` (`orm/src/builders.ts:1790`) exposes
`AlterType`/`AfterColumn`/`OldName` but **no `Table`**, and the compiler is resolved with the
column only (`orm-sql/src/compilers.ts:668`). Task 1's `IsStandaloneStatement` escape skips
the `ALTER TABLE x` prefix but supplies no table name.

The correct fix — `MsSqlAlterTableQueryCompiler extends SqlAlterTableQueryCompiler` handling
rename at the table level, where `Table` is available (no public-API change) — was scoped out:
nothing in this repo runs MSSQL, MSSQL cannot be executed here (no server), and nothing in
this plan needs MSSQL rename (Task 4 is a `MODIFY`). Building untestable rename machinery on
spec was declined.

**Known limitation left in place:** `orm-mssql` still inherits `orm-sql`'s alter compiler, so
it emits MySQL `MODIFY`/`AFTER`/`RENAME COLUMN` + backticks, which MSSQL rejects. This is no
worse than before this work — MSSQL's alter path has always been broken. When someone needs
it: add `MsSqlAlterColumnQueryCompiler` (overriding `_modify` → `ALTER COLUMN`, `_add` →
no `AFTER`) **and** `MsSqlAlterTableQueryCompiler` for rename, registered in
`orm-mssql/src/index.ts`. The Task 1 hook seam supports the first; the second is the missing
piece. Also note (pre-existing, separate): `MsSqlColumnQueryCompiler` emits `ENUM(...)` on the
CREATE path too, which is not an MSSQL type.

`IsStandaloneStatement` (Task 1) is currently unused by any driver. It stays as the documented
extension point for this future work — it is tested and harmless.

---

### Task 4: `queue` — the migration this was all for

**Files:**
- Create: `packages/queue/src/migrations/Queue_2026_07_17_00_00_00.ts`

**Interfaces:**
- Consumes: the working alter path from Tasks 1-2 (MySQL via orm-sql; sqlite no-op via orm-sqlite). Task 3 (MSSQL) is deferred and not needed here.

**Context:** `queue_jobs.Status` was created as a 4-value enum (`Queue_2022_10_18_01_13_00.ts:12`) but `packages/queue/src/index.ts:146` writes `'retrying'`/`'dead'`, and `JobModel.ts:21` types all six. On MySQL this errors or coerces. **Never edit the 2022 migration — it is already applied in production.**

- [ ] **Step 1: Write the migration**

**The builder chain matters — an earlier draft got it wrong and it was confirmed not to typecheck.** `.default().value('created')` returns a `ColumnQueryBuilder`, which has **no `.modify()`** (that lives on `AlterColumnQueryBuilder`). So the inline chain `.notNull().default().value('created').modify()` is a **type error**. Call `.modify()` on the column builder itself, separate from the default:

```ts
/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Widens `queue_jobs.Status` to the six states the code actually writes.
 * `retrying` / `dead` arrived with retry support (see index.ts) but the enum
 * was never widened, so strict-enum drivers reject or coerce them.
 *
 * NOT NULL and the 'created' default are restated deliberately: MySQL's MODIFY
 * COLUMN replaces the whole definition and silently drops anything omitted.
 * On sqlite this alteration is a logged no-op - it renders enum as
 * unconstrained TEXT, so there is nothing to widen there.
 */
@Migration('queue')
export class Queue_2026_07_17_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('queue_jobs', (table) => {
      const status = table.enum('Status', ['error', 'success', 'created', 'executing', 'retrying', 'dead']).notNull();
      status.default().value('created');
      status.modify();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
```

**Verify the exact chain against the real API** before trusting the above — read `orm/src/builders.ts` (`AlterColumnQueryBuilder` at :1790, `.modify()` at :1809, `ColumnQueryBuilder.default()` at :1759 returning `DefaultValueBuilder<ColumnQueryBuilder>`, `.value()` returning `ColumnQueryBuilder`). Confirm `table.enum(...)` returns something with both `.notNull()` and `.modify()` in scope; if the real type surface differs, adapt and report. Match `Queue_2026_06_30_00_00_00.ts`'s import/decorator idiom.

- [ ] **Step 2: Verify it compiles to the right SQL per driver**

`packages/queue`'s own suite needs an ActiveMQ broker and **fails at baseline** — you cannot use it. Instead, verify the compiled output directly:
- **sqlite**: build a container with `orm-sqlite`'s registrations, compile this alter, assert it yields **no statement** (the no-op) and does not throw.
- **mysql** (via `orm-sql`'s compilers, which are the MySQL dialect): assert it compiles to ``ALTER TABLE `queue_jobs` MODIFY `Status` ENUM('error','success','created','executing','retrying','dead') NOT NULL DEFAULT 'created'``.

Put these where they can actually run — likely small assertions in `orm-sqlite`'s and `orm-sql`'s suites, or a scratch script whose output you paste into your report. **Do not claim execution you did not perform.**

- [ ] **Step 3: Build and commit**

```bash
cd packages/queue && npm run build && npm run compile:cjs
cd ../..
git add packages/queue/src/migrations/Queue_2026_07_17_00_00_00.ts
git commit -m "fix(queue): widen Status enum to the six states the code writes

retrying/dead arrived with retry support but the column enum was never
widened, so strict-enum drivers reject or coerce them. New migration
rather than editing the applied 2022 one. NOT NULL and the default are
restated because MySQL's MODIFY drops omitted attributes; on sqlite the
alteration is a logged no-op."
```

---

### Task 5: Verification

- [ ] **Step 1: Baseline-diff every touched package**

Baselines to match (this repo has ~34 pre-existing failures; matching the baseline IS success):

```
orm-sql        119/7 baseline -> expect 122/7 (Task 1 added 3 tests)
orm-sqlite      41/8 baseline -> expect 52/8  (Task 2 added 11 tests)
orm             89/2 -> unchanged (Task 1 changed a class it depends on)
queue-http-progress  2 passing
```

Task 4 adds the migration and its verification tests (likely in orm-sql / orm-sqlite suites — wherever they can execute). Re-establish each baseline yourself and report a table: package | baseline | now | delta | verdict.

- [ ] **Step 2: Confirm no downstream breakage**

Rebuild + `compile:cjs` every package touched (`orm-sql`, `orm-sqlite`, `queue`), plus `orm-mysql` and `orm-mssql` (both inherit `orm-sql`'s alter compiler — mysql correctly, mssql still broken per the deferred Task 3). Report anything that fails to compile. **Task 3 (MSSQL) is deferred — do not expect orm-mssql source changes.**

- [ ] **Step 3: Report honestly**

State plainly: what was executed (sqlite, in-memory), what was only inspected (MySQL — no server; the compiled-string assertions run against orm-sql's compilers which ARE the MySQL dialect), that MSSQL was deferred entirely (still emits invalid alter SQL, no worse than before), and any pre-existing failure left alone.

---

## Notes for the implementer

- **The existing `orm-sql` alter tests are the bug's alibi** — they assert MySQL output under a connection literally named `'sqlite'` that is a fake driver registering `orm-sql`'s compilers (`orm-sql/test/fixture.ts:88-98`). Do not trust that file's naming, and do not add dialect assertions to it.
- **`@NewInstance()` + positional constructor args.** Compilers are resolved with `[builder]`. Adding `@Inject(Container)` shifts `builder` to the second position — `SqlTableQueryCompiler` (`:863`) already does exactly this, so copy it. `orm-sql/test/fixture.ts:98` and `MsSqlColumnQueryCompiler`'s constructor (`orm-mssql/src/compilers.ts:199`) must stay in sync or you get a **resolve-time** failure, not a compile error.
- `AlterColumnQueryBuilder extends ColumnQueryBuilder` (`orm/src/builders.ts:1790`), so handing it to a `ColumnQueryCompiler` is type-safe. No shim needed.
- Bash expands `test/**/*.test.ts` and can silently produce a **zero-test run that looks like a pass**. Prefer PowerShell for per-package test invocation, or verify the test count is non-zero.

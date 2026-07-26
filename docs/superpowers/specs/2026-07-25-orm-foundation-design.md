# Branch `orm-foundation` — shared groundwork

Date: 2026-07-25
Status: approved
Parent: [ORM overview](2026-07-25-orm-overview-design.md)
Forks from: `master`. Merges before `orm-infra`, `orm-uow`, `orm-perf`.

---

## 1. Why this branch exists

Changes needed by more than one themed branch, touching the same files
([builders.ts](../../../packages/orm/src/builders.ts),
[driver.ts](../../../packages/orm/src/driver.ts),
[orm-sql/statements.ts](../../../packages/orm-sql/src/statements.ts)). Landing them once here
keeps the themed branches independent and avoids three-way conflicts in the largest files in
the codebase.

All were deferred from iteration 1 (`orm-fixes-1`) as "iteration 2+, separate plan and
approval". This is that plan.

## 1a. State of the tree as of 2026-07-25

Part of this backlog landed on `orm-fixes-2` while this spec was being written. Verify before
starting rather than trusting this section:

| Item | State |
| --- | --- |
| F1 execute-once builder | Not started |
| F2 transaction contract | Not started |
| F3 identifier escaping | **In flight, uncommitted** — `escapeIdentifier()` exists in `orm-sql/src/compilers.ts` and is partially applied across `orm-sql/src/statements.ts` |
| F4 `clone()` completeness | **Done** — commit `ca91d3fb5` |
| F5 integration test infrastructure | Not started |

Also landed and no longer in `orm-infra`'s scope: B2, the per-statement WHERE/HAVING connector,
commit `00a81987f`.

## 2. Scope

### F1 — Execute-once query builder (A1, closes B8, B9, B19)

**Problem.** `QueryBuilder` implements `PromiseLike` by hand over mutable state. Awaiting a
builder compiles and executes it *and* mutates it. Consequences already catalogued:

- B8: the middleware array is appended to on each execution, so a re-awaited builder runs its
  middlewares twice.
- B9: values produced mid-chain are lost.
- B19: `toDB()` is not idempotent — calling it twice yields different SQL.

**Design.** Introduce `execute(): Promise<T>` holding a memoized promise field. `then()`,
`catch()` and `finally()` delegate to it. Compilation moves behind the memo, so `toDB()` is
computed from an immutable snapshot of builder state rather than mutating it.

Middlewares become an immutable per-execution list: the builder holds a template array,
`execute()` copies it, and the pipeline runs against the copy. This is what makes the
`_.uniqBy` workaround at
[middlewares.ts:262-268](../../../packages/orm/src/middlewares.ts#L262-L268) removable, though
the root-cause fix for duplicate registration belongs to `orm-uow`.

**Behaviour change.** Re-awaiting a builder returns the first result instead of re-running the
query. Callers relying on re-execution must call `.clone()` first. Documented in the changelog.

### F2 — ORM-level transaction contract (B24, A7)

**Problem.** `OrmDriver.transaction()` is abstract with no isolation level, no savepoints, and
no requirement that the transaction's connection be propagated to statements executed inside the
callback ([driver.ts:146](../../../packages/orm/src/driver.ts#L146)). Model writes inside a
transaction work today only because the MySQL driver independently chose `AsyncLocalStorage`
([orm-mysql/src/index.ts:41-43](../../../packages/orm-mysql/src/index.ts#L41-L43)). The
callback form does not auto-commit, which contradicts the API shape callers expect and leaks
connections when the convention is missed.

**Design.**

- `transaction(cb)` commits when the callback resolves, rolls back when it throws, and releases
  the connection exactly once on both paths.
- The `AsyncLocalStorage` transaction context moves from `orm-mysql` into the abstract
  `OrmDriver`, and "statements execute on the ambient transaction connection when one is
  active" becomes part of the contract rather than a driver detail. SQLite and MSSQL inherit it.
- Nesting maps to savepoints: a per-runner depth counter issues `BEGIN` at depth 0 and
  `SAVEPOINT sp_<n>` beyond it; commit/rollback mirror with `RELEASE SAVEPOINT` /
  `ROLLBACK TO SAVEPOINT`. `orm-uow` needs this for partial-graph rollback.
- `transaction(cb, { isolation })` accepts an isolation level, validated against a per-driver
  supported set and rejected with a clear error where unsupported.
- The explicit `begin`/`commit`/`rollback` object form remains as the low-level escape hatch.

**Behaviour change.** The callback form now commits automatically. Existing code that calls
`commit()` itself inside the callback must drop that call. Documented in the changelog.

### F3 — Identifier escaping (A3)

**Problem.** Identifiers are template-spliced with no escaping across
`_columnWrap`, `SqlJoinStatement`, `SqlTableAliasCompiler`, the exists handlers' `RawQuery`
fragments, and foreign-key DDL, which quotes nothing at all. Model-bound WHERE columns are
validated against the descriptor
([orm/src/statements.ts:163](../../../packages/orm/src/statements.ts#L163)), which mitigates the
common path, but `order()`, raw joins, schema names, and everything in the DDL builder are
unvalidated. The backtick dialect is hardcoded in the shared `orm-sql` layer, so `orm-mssql`
inherits the wrong quoting.

**Design.** A single `escapeIdentifier(name: string): string` on the dialect layer, defaulting to
backtick doubling in `orm-sql` and overridden to `[...]` with `]`-doubling in `orm-mssql`.
Every identifier splice site routes through it. A test enumerates the splice sites and asserts
that an identifier containing the dialect's quote character round-trips safely.

**Status.** In flight and uncommitted. `escapeIdentifier` already exists in
`orm-sql/src/compilers.ts` and has been applied to `_columnWrap`, `SqlGroupByStatement` and
`SqlJoinStatement`. Remaining work: finish the sweep (`SqlTableAliasCompiler`, the exists
handlers' `RawQuery` fragments, and all DDL in the schema compilers, which currently quote
nothing), add the `orm-mssql` override so it stops inheriting backticks, and add the
quote-character round-trip test.

### F4 — `clone()` completeness (B18) — **done**

Landed in commit `ca91d3fb5`: `clone()` now copies `_groupStatements`, `_relations` and
`_middlewares` alongside the fields it already handled, with relations and middlewares shared
using the same semantics as `mergeRelations()` / `mergeBuilder()`.

Remaining, optional: the reflective guard test — one that enumerates the builder's own
enumerable fields and fails when a field is neither cloned nor on an explicit exclusion list —
was not part of that commit. Without it the same class of omission can recur silently, which is
how B18 survived in the first place.

### F5 — Integration test infrastructure

**Problem.** There is no `docker-compose.yml` and no benchmark suite anywhere in the repo. The
iteration-1 report notes `orm-mysql` was never run for lack of a live database, so the MySQL
driver's behaviour is verified only by inspection. `orm-perf` cannot be evaluated at all without
this, and `orm-foundation`'s own transaction work cannot be proven on real connections.

**Design.**

- `docker-compose.yml` at the repo root providing MySQL, with a documented
  `ORM_TEST_MYSQL_*` environment convention and a compose profile so it is opt-in.
- `npm run test:integration` in `orm-mysql` and `orm-sqlite`, separate from the existing
  unit `test` script so CI without Docker is unaffected.
- Integration coverage for the transaction contract specifically: auto-commit on resolve,
  rollback on throw, savepoint nesting, connection released exactly once, and ambient-context
  propagation to model writes.

## 3. Non-goals

- Fixing the WHERE boolean model (B2) — that is `orm-infra`.
- Root-causing duplicate middleware registration — that is `orm-uow`; F1 only makes the
  pipeline immutable per execution.
- Any performance optimization — that is `orm-perf`, which builds its harness on F5.
- Isolation-level support beyond accepting and validating the option; no per-driver tuning.

## 4. Verification

- Unit suites for `orm` and `orm-sql` pass with no new failures against the current baseline
  (measure at branch start rather than assuming the iteration-1 numbers).
- New integration suite passes against docker MySQL and on-disk SQLite.
- Every fix lands with a red-first test, as in iteration 1.
- `orm-api`, `orm-http`, `intl-orm`, `queue-orm-transport` compile and their suites pass.

## 5. Risks

- **F1 is the highest-risk item.** The thenable is load-bearing everywhere; making execution
  memoized changes timing for any caller that awaited a builder more than once. Mitigation:
  audit all in-repo await sites before landing, and make the changelog entry explicit.
- **F2 changes transaction control flow** for every driver, including MSSQL which is out of
  investment scope but must keep working. Mitigation: contract-level tests that each driver
  must pass.
- **F3 touches the SQL every query produces.** Mitigation: the existing 142-test `orm-sql`
  suite asserts generated SQL strings, so escaping regressions surface immediately — but the
  expected strings in those tests will need updating, and each update must be reviewed as a
  deliberate change rather than blindly accepted.

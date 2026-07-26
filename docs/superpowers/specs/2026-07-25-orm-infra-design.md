# Branch `orm-infra` — production hardening

Date: 2026-07-25
Status: approved
Parent: [ORM overview](2026-07-25-orm-overview-design.md)
Forks from: `orm-foundation`. Independent of `orm-uow` and `orm-perf`.

---

## 1. Why this branch exists

Three defects cause real production pain and are not addressed by the persistence or
performance work. They share nothing architecturally, so they are grouped by impact rather
than by subsystem.

Selection was driven by what actually hurts, not by the full gap list. Migration locking for
multi-instance deploys was reviewed and deprioritized.

**State as of 2026-07-25:** I1 landed on `orm-fixes-2` (commit `00a81987f`) while this spec was
being written, and survives here only as changelog and consumer-verification obligations.
I2, I3 and I4 are not started. Verify before starting rather than trusting this note.

## 2. Scope

### I1 — Per-statement WHERE connector (B2) — **done**

Landed on `orm-fixes-2` in commit `00a81987f` while this spec was being written. The connector
now lives on the statement, captured at push time, and the compiler folds statements pairwise
instead of joining every statement in scope with whatever `_boolean` was set to last. HAVING
received the same treatment.

Two things this branch still owes:

- **Changelog entry.** Mixed `where`/`orWhere` chains now produce different — correct — SQL.
  `.where(a).orWhere(b).where(c)` was `a OR b OR c` and is now `a AND b OR c` grouped per the
  statement connectors. Any caller that depended on the old retroactive behaviour, deliberately
  or not, gets different results. This is the most likely source of downstream surprises in the
  3.0.0 release and needs before/after SQL in the changelog.
- **Consumer re-verification.** `orm-http` is the heaviest user of the WHERE surface and builds
  clauses directly from request DTOs; its translation layer may have been written around the old
  semantics. Its suite must be run and its filter-combination behaviour checked explicitly, not
  assumed from a clean compile.

### I2 — Composite primary keys

**Problem.** `IModelDescriptor.PrimaryKey` is a single string throughout, so composite-key
tables cannot be modelled at all — a hard blocker, not a degradation.

**Design.** `PrimaryKey` becomes `string[]`. The change ripples into:

- WHERE construction for `get`, `find`, `findOrFail`, `getOrFail`, `destroy`, `update`,
  `exists`, `getOrCreate`, `getOrNew` — single-column equality becomes a conjunction, and
  `find([...])` over composite keys becomes a disjunction of conjunctions rather than an `IN`.
- `PrimaryKeyValue` getter/setter on `ModelBase`
  ([model.ts:122-145](../../../packages/orm/src/model.ts#L122-L145)), including the existing
  cascade of a new PK into loaded relations.
- Relation foreign-key matching in `relations.ts` and `relation-objects.ts`, and the
  `whereIn(ForeignKey, pks)` batching in
  [middlewares.ts:62](../../../packages/orm/src/middlewares.ts#L62), which becomes a composite
  key match.
- Hydration grouping keys and `_dbDiff`'s `PK NOT IN (...)` orphan delete.
- The `_prepareOrderBy` helpers behind `first`/`last`/`newest`/`oldest`.

Single-column keys remain the overwhelmingly common case and must stay on the fast path: a
one-element array compiles to the same SQL as today, with no `AND` wrapper and no behavioural
difference.

**Sequencing note.** This is the largest item in the branch and mostly mechanical, but it
touches relation internals that `orm-uow` also rewrites. Landing `orm-infra` before or well
apart from `orm-uow` keeps the conflict surface manageable; if they run concurrently, expect
conflicts in `relation-objects.ts`.

### I3 — RETURNING and generated keys

**Problem.** Inserts read `insertId`, which is MySQL auto-increment semantics. A model with a
UUID or otherwise assigned string primary key learns nothing from its own insert, and the fp
helpers were written assuming auto-increment (the source of B11 in iteration 1). SQLite emits
`RETURNING` but only on its upsert path
([orm-sqlite/src/compilers.ts:81-86](../../../packages/orm-sqlite/src/compilers.ts#L81-L86));
MySQL and MSSQL never read `getReturning()` at all, so the existing `returning()` builder method
is a no-op there.

**Design.**

- `@Primary()` gains a generation strategy: `auto` (database identity column), `uuid`
  (generated client-side immediately before insert, so the value is known without a round-trip),
  `assigned` (caller supplies it). Default is `auto`, preserving today's behaviour.
- The driver insert result becomes a structured `IInsertResult` carrying `RowsAffected`,
  `LastInsertId` where meaningful, and `Returning` rows where the dialect supports them.
- SQLite emits `RETURNING` on plain inserts, not only upserts. MySQL uses `insertId` for `auto`
  and the pre-generated value for `uuid` / `assigned`. MSSQL keeps its `SCOPE_IDENTITY()` path.
- `returning()` throws a clear `NotSupported` on dialects that cannot honour it, rather than
  silently doing nothing.

This is also a prerequisite for `orm-uow` backfilling generated parent keys into cascaded
children, so its interface is designed with that consumer in mind even though `orm-uow` forks
from `orm-foundation` rather than from here.

### I4 — Connection resilience and pool behaviour

**Problem.** One health check at startup, no reconnect, no backoff, no pool metrics. After a
database restart or a network blip the pool can be left with dead connections. SQLite has no
pool at all — a single `sqlite3.Database` handle
([orm-sqlite/src/index.ts:37](../../../packages/orm-sqlite/src/index.ts#L37)) through which every
concurrent query serializes.

**Design.**

- Pool configuration surfaced properly on the connection options: min, max, idle timeout,
  acquire timeout. Today only `PoolLimit` is exposed.
- Reconnect with bounded exponential backoff on connection-level failures, distinguishing
  retryable transport errors from query errors, which must still propagate immediately.
- A periodic health check replacing the single startup probe, with a driver-level
  connected/degraded state that surfaces in logs.
- Pool metrics (size, in-use, waiting, acquire latency) published through `@spinajs/metrics`.
- SQLite: serialization documented as intended behaviour, plus an optional pool of read-only
  handles so reads stop queueing behind each other. Writes stay on the single writer handle.

## 3. Non-goals

- Optimistic locking / `@Version` columns. Related to I2/I3 but no demand identified.
- Locking clauses (`FOR UPDATE`, `SKIP LOCKED`).
- Migration advisory locking for concurrent migrators — reviewed and deprioritized.
- Query-shape or statement caching — that is `orm-perf`.
- PostgreSQL.

## 4. Verification

- Red-first test per fix.
- I1: already covered by the tests in `00a81987f`; this branch adds only the regression test
  driven through `orm-http`'s DTO translation.
- I2: a composite-key fixture model exercised end-to-end through get/find/destroy/update,
  relation batching, and orphan diffing, on both MySQL and SQLite integration suites.
- I3: integration tests asserting the returned key for each `@Primary()` strategy on each
  in-scope driver.
- I4: integration test that kills and restarts the MySQL container mid-suite and asserts the
  pool recovers without process restart.
- `orm-api`, `orm-http`, `intl-orm`, `queue-orm-transport`, `orm-threading` compile and pass.

## 5. Deliverables

- Changelog covering I1's semantic change, I2's descriptor type change, I3's insert-result
  shape change, and I4's option additions.
- 3.0.0 version bump across the affected packages.
- Consumer updates in the same branch.

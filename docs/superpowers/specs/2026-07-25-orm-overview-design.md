# SpinaJS ORM — comparative analysis vs TypeORM, and a four-branch improvement design

Date: 2026-07-25
Status: approved
Supersedes nothing. Builds on [`docs/orm-analysis.md`](../../orm-analysis.md) (iteration 1, branch `orm-fixes-1`).

---

## 1. Purpose

This document records a feature-by-feature comparison of `@spinajs/orm` + `@spinajs/orm-sql`
against TypeORM, and the design decisions that split the resulting work into four branches.

Each branch has its own spec:

| Branch | Spec | Theme |
| --- | --- | --- |
| `orm-foundation` | [foundation](2026-07-25-orm-foundation-design.md) | Shared groundwork; merges first |
| `orm-infra` | [infra](2026-07-25-orm-infra-design.md) | Production hardening |
| `orm-uow` | [uow](2026-07-25-orm-uow-design.md) | Unit-of-work persistence |
| `orm-perf` | [perf](2026-07-25-orm-perf-design.md) | Throughput and latency |

**Currency warning.** Work landed on `orm-fixes-2` while these specs were being written —
`ca91d3fb5` (B18, `clone()` completeness) and `00a81987f` (B2, per-statement WHERE connector) —
and identifier escaping was in flight uncommitted. Each branch spec carries a state table, but
those tables were accurate at 2026-07-25 only. Check `git log` against the spec before starting
any branch.

## 2. What was compared

- `packages/orm` (~7,900 LOC) and `packages/orm-sql` (~1,950 LOC), plus the
  `orm-mysql`, `orm-sqlite`, `orm-mssql` drivers and the consumers
  `orm-api`, `orm-http`, `intl-orm`, `queue-orm-transport`, `orm-threading`.
- TypeORM at `c:\Users\grzch\SourceCodes\typeorm` (v1.0 track, commit `281bfba4`).

## 3. Comparison findings

### 3.1 Where SpinaJS is already sound

Relation loading is better than its reputation suggests. `belongsTo` compiles into a
`LEFT JOIN` merged into the parent query
([relations.ts:134-167](../../../packages/orm/src/relations.ts#L134-L167)), and `hasMany` /
`manyToMany` are loaded by a single batched `WHERE fk IN (...)` over all parent keys collected
from the hydrated page ([middlewares.ts:24-68](../../../packages/orm/src/middlewares.ts#L24-L68),
[middlewares.ts:198-229](../../../packages/orm/src/middlewares.ts#L198-L229)). A flat
`hasMany` populate costs two queries, not N+1. This matches what TypeORM calls
`relationLoadStrategy: "query"` and is the strategy TypeORM recommends for deep graphs.

Nested populate works to arbitrary depth via dotted paths, with `belongsTo` chains folding
into a single multi-join query ([builders.ts:1213-1220](../../../packages/orm/src/builders.ts#L1213-L1220)).

Parameter values are bound as `?` placeholders throughout the compiler layer; there is no
value interpolation. (Identifiers are a separate problem — see §3.2.)

Soft delete, discrimination maps, migrations with per-migration transactions, an ActiveRecord
static/instance API, dirty tracking, and DDL schema building all exist and work.

### 3.2 Where SpinaJS is genuinely behind

**Persistence has no atomicity.** No relation write path opens a transaction. `sync()` is
`update()` followed by an orphan-delete as independent statements
([relation-objects.ts:519-522](../../../packages/orm/src/relation-objects.ts#L519-L522)); a throw
between them leaves the database inconsistent with the in-memory graph. `insert()` never
cascades, so persisting a parent with children is three or more unprotected batches.
TypeORM's `SubjectExecutor` does the whole graph in one transaction with FK-topological ordering.

**No identity map.** Every hydration allocates fresh instances; the same row reached by two
paths yields two disconnected objects. TypeORM also lacks a cross-query identity map, but it
compensates by reloading and diffing against the database on every `save()`.

**Identifiers are raw string interpolation.** Table names, aliases, join keys and all DDL are
template-spliced with no escaping (`A3` in the iteration-1 analysis). The backtick dialect is
hardcoded in the shared `orm-sql` layer, which `orm-mssql` then inherits incorrectly.

**Single WHERE connector per builder scope** — *fixed on `orm-fixes-2` during the writing of
this document, commit `00a81987f`.* `_boolean` was one flag on the builder and the compiler
joined every statement with whatever it was set to last, so `.where(a).orWhere(b).where(c)`
yielded `a OR b OR c`. The connector now lives on the statement, as in Knex and TypeORM. What
remains is the changelog and consumer re-verification, tracked in the `orm-infra` spec.

**The thenable builder re-executes.** `PromiseLike` is implemented by hand on mutable state,
producing the B8/B9/B19 cluster: middleware arrays mutate per await, mid-chain values are lost,
`toDB()` is not idempotent.

**Absent query features:** locking clauses (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`),
general CTEs (only one fixed-name recursive CTE), set operations, window functions,
`whereIn` with a subquery, `DISTINCT ON`, JSON path operators, full-text.

**Absent persistence features:** composite primary keys, optimistic locking / version columns,
`RETURNING` beyond SQLite's upsert path, cursor pagination, cascade configuration,
orphan-removal policy.

**Absent runtime facilities:** streaming or cursor reads (all drivers buffer whole result sets),
chunked batch writes, prepared-statement reuse (MySQL calls `pool.query`, not `.execute()`),
query result caching, reconnect/backoff, pool metrics.

**Transactions are driver-level.** `OrmDriver.transaction()` is abstract with no isolation
level, no savepoints, and no required context propagation
([driver.ts:146](../../../packages/orm/src/driver.ts#L146)). Model writes inside a transaction
work only because the MySQL driver happens to use `AsyncLocalStorage`
([orm-mysql/src/index.ts:41-43](../../../packages/orm-mysql/src/index.ts#L41-L43)); the abstract
contract does not require it, so other drivers may silently execute "transactional" statements
on the pool.

### 3.3 What TypeORM does that is worth importing

- **Transactional graph persistence** with topological ordering by FK dependency and junction
  diffing (`SubjectExecutor`, `SubjectTopologicalSorter`) — adopted in `orm-uow`.
- **Orphan-row policy** (`nullify` / `delete` / `soft-delete` / `disable`) — adopted in `orm-uow`.
- **Savepoint-based transaction nesting** with a per-runner depth counter — adopted in
  `orm-foundation`.
- **Chunked saves** to stay under packet and placeholder limits — adopted in `orm-perf`.
- **Statement caching** (TypeORM does this only in its `better-sqlite3` driver) — generalized in
  `orm-perf`.
- **Streaming reads** that bypass hydration — adopted in `orm-perf`.
- **Two-phase pagination** for joined `hasMany` with limit/offset — *not* adopted; SpinaJS's
  `hasMany` loading is already a separate batched query, so the problem TypeORM solves here
  does not arise on that path.

### 3.4 What TypeORM does that is worth avoiding

- **Reload-and-diff on every `save()`.** Because TypeORM has no snapshot, it must re-SELECT
  current database state to know what changed, costing a round-trip per involved table per save.
- **`[]` versus `undefined` as the only "untouched" signal.** The direct consequence of the
  above: initializing a relation property to an empty array silently deletes every related row
  on save. TypeORM documents this as an FAQ because the architecture cannot distinguish the cases.
  SpinaJS *can* — relation lists carry a `Populated` flag and models have Proxy dirty tracking.
- **Promise-typed lazy relations**, which TypeORM itself labels experimental and which make
  every relation access a potential missing-`await` bug.
- **TTL-only query result cache** with no write invalidation.
- **Schema-diffing `synchronize()`**, a long-standing source of false-positive migrations.

## 4. Cross-branch decisions

These were settled before the branch specs were written and apply to all of them.

**D1 — Breaking changes are allowed; one major bump.** These packages are published
(`@spinajs/orm` is at 2.0.481, `private: false`), so the target is 3.0.0. Every behavioural
change is recorded in a changelog, and the in-repo consumers (`orm-api`, `orm-http`,
`intl-orm`, `queue-orm-transport`, `orm-threading`) are updated in the branch that breaks them.

**D2 — Drivers in scope are MySQL and SQLite.** MSSQL must keep compiling and passing its
suite but receives no investment. No PostgreSQL driver is in scope; that would be a separate
project.

**D3 — Shared groundwork lands first in `orm-foundation`.** The three themed branches fork
from it and stay independent of each other.

**D4 — Merge order is `orm-foundation` → `orm-infra` → `orm-uow` → `orm-perf`.**
`orm-infra` is independent and can proceed in parallel. `orm-uow` and `orm-perf` both rewrite
hydration ([hydrators.ts](../../../packages/orm/src/hydrators.ts) and the model Proxy at
[model.ts:23-38](../../../packages/orm/src/model.ts#L23-L38)); sequencing `orm-uow` first means
`orm-perf` optimizes the settled shape once rather than optimizing twice.

**D5 — Persistence model is full unit-of-work.** `save()` walks the loaded graph, diffs,
topologically sorts, and executes atomically. Rationale and the rejected alternative
(atomic ActiveRecord with opt-in cascade) are recorded in the `orm-uow` spec.

**D6 — The diff baseline is a snapshot taken at hydration**, with `save({ reload: true })` as
the opt-in for workloads where another process may modify rows concurrently. This avoids
TypeORM's per-save SELECT cost and, combined with the `Populated` flag, eliminates the
empty-array hazard.

**D7 — The identity map is scoped to one transaction or one `save()` graph walk**, then
discarded. It exists to prevent duplicate subjects for one row, not to cache across requests.
No cross-request or global caching, so no stale-entity or unbounded-growth risk.

**D8 — `populate()` semantics do not change.** Performance work on relation loading must
preserve the current dotted-path chaining API and its observable behaviour.

**D9 — Performance claims must be measured.** `orm-foundation` adds a docker-compose MySQL
and an integration-test entry point; `orm-perf` builds a benchmark harness on it and records a
baseline before any optimization. A change that does not measurably help is dropped, not merged
on reasoning.

## 5. Out of scope

Deliberately excluded from all four branches, recorded so the decision is not relitigated:

- PostgreSQL driver.
- Query result caching (TTL-only invalidation is a correctness hazard; no demand identified).
- Tree repositories beyond the existing recursive-CTE `belongsTo` (materialized path, nested
  set, closure table).
- Polymorphic relations.
- Schema-diffing migration generation and `synchronize()`.
- Window functions, set operations, `DISTINCT ON`, JSON path operators, full-text search.
- Migration locking for multi-instance deploys — reviewed and explicitly deprioritized as not
  a current production pain.
- Lazy Promise-typed relations.

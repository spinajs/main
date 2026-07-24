# Branch `orm-perf` — throughput and latency

Date: 2026-07-25
Status: approved
Parent: [ORM overview](2026-07-25-orm-overview-design.md)
Forks from: `orm-foundation`. Merges after `orm-uow`.

---

## 1. Why this branch exists and why it merges last

Four workload shapes were identified as costly: large result sets, write throughput, per-query
overhead, and deep relation graphs. Three of the four bottom out in code that `orm-uow` also
rewrites — [hydrators.ts](../../../packages/orm/src/hydrators.ts), the model Proxy at
[model.ts:23-38](../../../packages/orm/src/model.ts#L23-L38), and the relation write loops. This
branch merges after `orm-uow` so hydration and persistence are optimized once in their settled
shape rather than twice.

**Binding constraint (overview decision D8): `populate()` semantics do not change.** Dotted-path
chaining and its observable behaviour stay exactly as they are. Relation work here is limited to
making the existing behaviour faster.

## 2. P0 — Benchmark harness, before anything else

There is currently no benchmark suite in the repo, and the MySQL driver has never been run
against a live database in the test suite. Every claim in this branch is therefore unverified
until this exists.

Built on `orm-foundation`'s docker-compose MySQL and on-disk SQLite. Scenarios:

- 10k-row select with hydration; the same select with `stream()`.
- Bulk insert at several array sizes, spanning the point where chunking should engage.
- Small-query latency loop — the same query shape executed thousands of times, isolating SQL
  building and builder construction from database time.
- Three-level `populate()` chain mixing `belongsTo` and `hasMany`.
- A `Virtual` relation over a multi-row result, which is the one true N+1 path.

Baseline numbers are recorded in the repo before any optimization lands. Every subsequent change
reports a measured delta. **A change that does not measurably help is dropped, not merged on
reasoning** (overview decision D9).

## 3. Scope

### P1 — Large result sets and memory

**Problem.** Every driver resolves the entire result set into memory before hydration:
`resolve(rows)` in MySQL, `resolve(results)` in SQLite, `result.recordset` in MSSQL. Hydration
then allocates a model instance and a `Proxy` per row.

**Design.**

- `SelectQueryBuilder.stream()` returning an async iterable of hydrated models, over mysql2's
  query stream and SQLite's `each`. `await query` is untouched. Relation middlewares that batch
  over a whole page (`hasMany`, `manyToMany`) cannot run against an unbounded stream; streaming
  either rejects populated relations with a clear error or batches per configurable window —
  the benchmark decides which, and the chosen behaviour is documented rather than left implicit.
- The per-row dirty-tracking Proxy is the allocation hotspot. Create it lazily on first write
  instead of at construction, so read-only result sets never pay for it. This interacts with
  `orm-uow`'s snapshot layer, which is why this branch merges second.
- Cache the per-descriptor column list rather than recomputing it per row.
- Fix the `Object.assign(d)` single-argument no-op at
  [middlewares.ts:278](../../../packages/orm/src/middlewares.ts#L278) if `orm-uow` has not
  already; it intends a clone and actually aliases.

### P2 — Write throughput

**Problem.** `insert(array)` builds one unbounded `INSERT … VALUES (…),(…)` statement regardless
of array size, so a large array produces an oversized statement and binding list. Relation
`update()` inserts children one at a time in a `for … await` loop
([relation-objects.ts:542-544](../../../packages/orm/src/relation-objects.ts#L542-L544)), and the
many-to-many path constructs and inserts one junction model per pair
([relation-objects.ts:408-428](../../../packages/orm/src/relation-objects.ts#L408-L428)).

**Design.**

- Chunked multi-row inserts, with a default chunk size derived from the driver's placeholder and
  packet limits and overridable per call. Chunks execute within the caller's transaction when
  one is active.
- Relation and junction writes become batched multi-row inserts instead of per-row loops. After
  `orm-uow`, this means the executor emits one statement per table per operation.

### P3 — Per-query overhead

**Problem.** Every execution compiles a fresh SQL string and sends it via `pool.query`
([orm-mysql/src/index.ts:45-47](../../../packages/orm-mysql/src/index.ts#L45-L47)), which is
mysql2's client-side placeholder substitution — not a server-side prepared statement. There is no
statement handle reuse anywhere. For workloads dominated by many small queries, SQL building,
descriptor lookups and middleware setup can rival database time.

**Design.**

- A compiled-SQL cache keyed by builder shape (table, columns, statement structure, join
  structure) with bindings kept separate. This is the enabling change for the next item: real
  prepared statements require a stable placeholder count, which only a shape-keyed cache
  guarantees.
- Switch MySQL to mysql2's `.execute()` for shape-cached queries, giving server-side prepared
  statements, with a per-connection LRU on the statement cache so a long-lived pool connection
  cannot accumulate handles without bound. TypeORM does this only in its `better-sqlite3`
  driver; generalizing it is a genuine improvement over TypeORM, not a copy.
- SQLite gains an equivalent prepared-statement cache on its single handle.
- Cheaper builder construction: the `typescript-mix` `@use` mixin machinery and repeated
  descriptor lookups are measured before being touched — this is a suspicion, not an
  established cost, and P0's latency loop settles it.

### P4 — Deep relation graphs, without changing semantics

**Problem.** `Virtual` relations run one `populate()` per row
([middlewares.ts:177-184](../../../packages/orm/src/middlewares.ts#L177-L184)) — genuine N+1,
the only such path left, since `hasMany` and `manyToMany` already batch. Sibling relations at
the same nesting level are awaited serially even though they are independent queries.

**Design.**

- A batch entry point for `Virtual` relations, matching the batching contract the other relation
  kinds already implement, so a user-supplied relation class can receive the whole row set. The
  per-row path stays as the fallback for relation classes that do not implement the batch hook,
  so existing custom relations keep working.
- Sibling relations at the same nesting level load in parallel. Note TypeORM found this unsafe
  for PostgreSQL's single-connection-per-runner model and forces serial execution there;
  MySQL and SQLite are in scope here, and the parallel path is gated on driver capability rather
  than assumed safe.
- No change to dotted-path chaining, populate ordering, or the shape of populated results.

## 4. Non-goals

- Query result caching. TTL-only invalidation is a correctness hazard and no demand was
  identified.
- Changing `populate()` API or semantics (D8).
- A join-based loading strategy for `hasMany` as an alternative to batched queries — that is a
  semantic change and the batched path is already the strategy TypeORM recommends for depth.
- MSSQL optimization. It must keep compiling and passing; it receives no investment.
- PostgreSQL.

## 5. Verification

- P0's baseline is committed before any optimization; each subsequent change commits its
  measured delta alongside the code.
- Correctness first: every optimization ships with tests proving observable behaviour is
  unchanged. A faster wrong answer is a regression.
- Streaming: an integration test asserting bounded memory over a large result set, and an
  explicit test of the documented behaviour when a streamed query has populated relations.
- Prepared statements: an integration test asserting handle reuse across executions and LRU
  eviction under a shape-varying workload.
- Parallel sibling loads: a test asserting result equivalence with the serial path, on both
  in-scope drivers.
- Full `orm`, `orm-sql`, `orm-mysql`, `orm-sqlite` suites plus consumers.

## 6. Risks

- **Optimizing before measuring.** The single largest risk in this branch; P0 exists to prevent
  it, and the drop-if-not-measurable rule is the enforcement mechanism.
- **Lazy Proxy creation changes dirty-tracking timing.** If a model is mutated through a path
  that bypasses the trap before the Proxy is installed, changes are silently lost — the same
  class of failure as an aliased snapshot. Needs direct tests on the dirty-tracking layer, not
  just end-to-end behaviour.
- **Prepared statements are stateful per connection.** A pooled connection that is reset or
  reconnected invalidates its handles; the cache must key on connection identity and survive
  `orm-infra`'s reconnect logic if both have landed.
- **Streaming plus relation batching are fundamentally in tension.** Resolving this by
  documentation rather than by silently degrading is a stated requirement, not a fallback.

# Branch `orm-uow` — unit-of-work persistence

Date: 2026-07-25
Status: approved
Parent: [ORM overview](2026-07-25-orm-overview-design.md)
Forks from: `orm-foundation`. Merges before `orm-perf`.

---

## 1. Why this branch exists

No relation write path in SpinaJS opens a transaction. Persisting a parent with children today
is a sequence of independent, unprotected statement batches:

```ts
const order = new Order({ Total: 120 });
order.Client.attach(client);
await order.insert();              // inserts ONLY the orders row

order.Items.push(new OrderItem({ Sku: 'A', Qty: 2 }));
await order.Items.sync();          // N sequential INSERTs, then a DELETE for orphans

order.Tags.push(tag);
await order.Tags.sync();           // N junction INSERTs, then a DELETE
```

`insert()` never cascades ([model.ts:546-582](../../../packages/orm/src/model.ts#L546-L582)),
`sync()` is `update()` followed by an orphan delete as separate statements
([relation-objects.ts:519-522](../../../packages/orm/src/relation-objects.ts#L519-L522)), and
children are inserted one at a time in a `for … await` loop
([relation-objects.ts:542-544](../../../packages/orm/src/relation-objects.ts#L542-L544)). A throw
anywhere leaves the database inconsistent with the in-memory graph.

## 2. Decision: full unit-of-work

Two models were considered.

**Rejected — atomic ActiveRecord with opt-in cascade.** Keep explicit `sync()`/`update()` calls,
make each batch transactional, add `cascade: true` on relation decorators so children ride along
with the parent in FK-safe order. Roughly 400-600 LOC, no extra reads, no hidden graph walking.
Rejected because the caller still carries the ordering and "which collections changed" burden.

**Chosen — unit-of-work `save()`.** Mutate a loaded graph, call one method:

```ts
const order = await Order.query().where({ Id: 1 }).populate('Items').populate('Tags').first();

order.Total = 130;
order.Items[0].Qty = 5;
order.Items.splice(1, 1);
order.Tags.push(newTag);

await order.save();
// one transaction: UPDATE orders, UPDATE order_items(#0),
//                  DELETE order_items(#1), INSERT order_tags, COMMIT
```

This is TypeORM's persistence model, with two deliberate divergences described below.

## 3. Divergences from TypeORM

### Snapshot diffing instead of reload-and-diff

TypeORM re-SELECTs current database state on every `save()` to compute its diff, costing a
round-trip per involved table. SpinaJS records a snapshot when data is hydrated and diffs
against that, so `save()` costs no extra reads.

`save({ reload: true })` re-reads inside the transaction for workloads where another process may
modify the same rows concurrently. Snapshot diffing cannot see concurrent modification; that
trade is accepted as the default and the escape hatch is explicit.

### `Populated` distinguishes untouched from cleared

TypeORM's best-known footgun is that `undefined` versus `[]` is its only signal for "untouched"
versus "cleared", so `Items: OrderItem[] = []` on a class silently deletes every related row on
save. TypeORM documents this as an FAQ because its architecture cannot tell the cases apart.

SpinaJS can. Relation lists carry `Populated`
([relation-objects.ts:61](../../../packages/orm/src/relation-objects.ts#L61)) and models have
Proxy-based dirty tracking. A relation that was never populated and never mutated is *untouched*
and is skipped entirely by `save()`. An empty array on a freshly constructed model deletes
nothing.

## 4. Scope

### U1 — Snapshot on hydrate

A `__snapshot__` per model recording column values at hydration time, and per relation recording
the member primary keys captured when `Populated` is set. Written in
[hydrators.ts](../../../packages/orm/src/hydrators.ts) and at each `populate()` completion.

The snapshot is the diff baseline. It must be a shallow value copy, not an alias — note the
existing `Object.assign(d)` single-argument no-op at
[middlewares.ts:278](../../../packages/orm/src/middlewares.ts#L278), which intends a clone and
actually aliases and mutates the original row. That bug is fixed here.

### U2 — Identity map

Scoped to one transaction or one `save()` graph walk, then discarded (overview decision D7). Its
purpose is that a row reached through two relation paths produces one subject rather than two
conflicting ones. Keyed by model constructor identity plus primary key — not by class *name*,
because name-based lookup is already an architectural weakness (A9) and breaks under
minification or duplicate class names across connections.

Queries outside a save behave exactly as today. No cross-request caching.

### U3 — Subject model and builders

A `Subject` per involved entity carrying: the model instance, its descriptor, the operation
(`insert` / `update` / `delete` / `soft-delete`), the changed column set, and the relation deltas.

One builder per relation kind, mirroring TypeORM's split but smaller because SpinaJS has fewer
relation types to serve:

- `belongsTo` — resolve the FK value from the related model, which may not have its key yet.
- `hasMany` — added, updated and removed members, from the snapshot diff.
- `manyToMany` — junction rows to insert and to delete, from the member-PK set difference.
- `Query` and `Virtual` relations are read-only and produce no subjects.

### U4 — Topological ordering

Subjects are sorted by foreign-key dependency so a parent is inserted before any child that
references it, and deletes run in reverse. Cycles are detected and reported as a clear error
naming the models involved, rather than deadlocking or emitting invalid SQL.

Self-referencing relations, which produce a cycle at the model level but not at the row level,
are handled by deferring the self-FK to a follow-up `UPDATE` after insert — the same technique
TypeORM uses.

### U5 — Executor

One transaction (from `orm-foundation`'s contract), executing in order:

1. Inserts in FK-safe order, with generated primary keys backfilled into dependent children.
2. Updates, restricted to changed columns from the snapshot diff.
3. Junction inserts and deletes.
4. Orphan handling per the relation's configured policy.
5. Deletes.

Orphan policy is configured on the relation decorator: `nullify` (default; falls back to delete
when the FK is non-nullable, since nulling would violate the constraint), `delete`,
`soft-delete` (for models carrying `@SoftDelete`), `disable`.

Savepoints from `orm-foundation` allow a sub-graph failure to roll back without discarding the
whole transaction where that is meaningful.

### U6 — `save()` API

`ModelBase.save(options?)` with `{ reload?: boolean, chunk?: number }`. The existing
`insert()`, `update()`, `insertOrUpdate()`, `destroy()` and the relation-level `sync()` /
`update()` remain and become individually transactional, so existing code keeps working and gets
atomicity for free.

### U7 — Relation defects that would undermine `save()`

These are fixed here because a graph walker cannot be correct on top of them:

- Duplicate middleware registration, currently worked around with `_.uniqBy` and an explicit
  HACK comment at
  [middlewares.ts:262-268](../../../packages/orm/src/middlewares.ts#L262-L268). The root cause
  is nested `belongsTo` under `manyToMany` adding the same middleware more than once.
  `orm-foundation`'s immutable per-execution pipeline makes the fix possible; the root cause is
  fixed here and the workaround removed.
- Switch fallthrough from `Many` into `ManyToMany` in `ModelBase.attach()`
  ([model.ts:438-446](../../../packages/orm/src/model.ts#L438-L446)) — works by accident today
  because both backing objects are array-like.
- Static `populate()` silently does nothing for many-to-many
  ([model.ts:813-815](../../../packages/orm/src/model.ts#L813-L815)) — a `break` with no
  implementation, returning `undefined` with no error.
- `ManyToManyRelationList.union` / `intersection` / `diff` throw `Method not implemented`
  ([relation-objects.ts:312-322](../../../packages/orm/src/relation-objects.ts#L312-L322)) while
  `OneToManyRelationList` implements all three. The diffing engine needs them.
- `SingleRelation.populate()` re-queries the owner's entire row to load one relation
  ([relation-objects.ts:229-236](../../../packages/orm/src/relation-objects.ts#L229-L236)), with
  a TODO saying so.
- `SingleRelation.attach()` reaches into the owner's private `__dirty_props__` through an `any`
  cast marked "TODO hack"
  ([relation-objects.ts:214](../../../packages/orm/src/relation-objects.ts#L214)). Dirty state
  gets a proper `markDirty(prop)` method on the model (A6), which the snapshot layer needs anyway.

## 5. Non-goals

- Polymorphic relations.
- Tree strategies beyond the existing recursive-CTE `belongsTo` — no materialized path, nested
  set or closure table.
- Lazy Promise-typed relations.
- Cross-request or global identity mapping.
- Query result caching.
- Performance tuning of hydration — `orm-perf` owns that and merges after.

## 6. Verification

- Red-first test per behaviour.
- Graph fixtures covering: parent with new children; parent with removed children; re-parented
  children; many-to-many membership added and removed; self-referencing hierarchy; a cycle that
  must be reported as an error.
- Atomicity tests that force a failure partway through a graph save and assert the database is
  unchanged.
- An explicit regression test that `Items: OrderItem[] = []` on a constructed model deletes
  nothing — the anti-footgun guarantee.
- Snapshot-versus-`reload: true` divergence test: modify a row out-of-band, then assert the
  documented behaviour of each mode.
- Integration suites on MySQL and SQLite, since transaction and FK semantics differ.
- `queue-orm-transport` and `intl-orm` suites, both of which use relation objects directly.

## 7. Risks

- **Largest branch by far**, estimated 1,500-2,500 LOC of new subsystem plus the relation fixes.
  Worth splitting into reviewable phases: snapshot and identity map, then subjects and sorting,
  then the executor, then U7.
- **Snapshot correctness is load-bearing.** If a snapshot is aliased rather than copied, the
  diff is always empty and `save()` silently does nothing. The `Object.assign` aliasing bug in
  U1 is precisely this failure mode already present in the codebase; tests must assert
  snapshot immutability directly, not just end-to-end save behaviour.
- **Conflicts with `orm-infra`** in `relation-objects.ts` if composite primary keys land
  concurrently. Prefer sequencing.
- **Conflicts with `orm-perf`** in `hydrators.ts` and the model Proxy — resolved by the agreed
  merge order (D4).

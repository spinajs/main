# Unit of work — what `save()` does

`model.save()` persists that model **and everything reachable from it** in one transaction. It
is a different mechanism from `insert()` / `update()`, which write one row each.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;

  public Sku: string;

  public Quantity: number;
}

@Connection('default')
@Model('clients')
export class Client extends ModelBase<Client> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public client_id: number;

  public Reference: string;

  @BelongsTo(Client, 'client_id', 'Id')
  public Client: SingleRelation<Client>;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function placeOrder() {
  const order = new Order({ Reference: 'ORD-1' });

  order.Client.attach(new Client({ Name: 'Acme' }));
  order.Items.push(new OrderItem({ Sku: 'A-1', Quantity: 2 }));
  order.Items.push(new OrderItem({ Sku: 'B-2', Quantity: 1 }));

  // One transaction: insert Client, then Order with its client_id, then both items.
  const result = await order.save();

  return result; // { Inserted: 4, Updated: 0, Deleted: 0, ... }
}
```

## The pipeline

```
save(root)
  └─ driver.transaction(...)
       ├─ IdentityMap                    canonicalize instances
       ├─ SubjectBuilder.collect(root)   breadth-first graph walk
       ├─ assertSingleConnection         refuse a graph spanning connections
       ├─ reloadSnapshots                only with { reload: true }
       ├─ SubjectBuilder.buildFrom       diff into a SubjectSet
       ├─ SubjectSorter.sort             topological order
       ├─ SubjectExecutor.execute        run the statements
       └─ resnapshotRelations            rebase for the next save
```

## `ISaveOptions` and `ISaveResult`

```ts sample
import { Connection, Model, ModelBase, Primary, ISaveOptions, ISaveResult } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Reference: string;
}

export async function saving(order: Order): Promise<ISaveResult> {
  const options: ISaveOptions = {
    // Re-read every already-persisted model inside the transaction and diff against
    // that instead of the hydration snapshot. Costs one SELECT per involved table.
    reload: true,
    // Rows per batched statement — junction inserts and orphan key lists. Default 100.
    chunk: 250,
  };

  return await order.save(options);
}
```

`ISaveResult` counts what actually happened: `Inserted`, `Updated`, `Deleted`, `SoftDeleted`,
`JunctionInserted`, `JunctionDeleted`.

## Traversal rules

Which relations `save()` follows is the single most important thing to understand about it.

| Relation | Followed when |
| --- | --- |
| `belongsTo` (`One`) | Its `Value` is set — populated or not. Attaching a model is an explicit act. |
| `hasMany` (`Many`) | **`Populated === true` only.** |
| `manyToMany` | **`Populated === true` only.** |
| `Query`, `Virtual` | Never. They are read-only projections. |

The `Populated` requirement is a deliberate anti-footgun and the main divergence from TypeORM:

> A relation that was never populated is invisible. `Items` on a freshly constructed model
> deletes nothing.

Without it, loading an order without its items and saving it would delete every item — the
in-memory list is empty, so the diff would read "all members removed".

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;

  public Sku: string;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Reference: string;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function safeByDefault() {
  const order = await Order.getOrFail(1);

  order.Reference = 'ORD-RENAMED';

  // Items was never populated => the relation is invisible => no item is touched.
  await order.save();
}

export async function intentionalRemoval() {
  const order = await Order.getOrFail(1);

  // Now the relation IS populated, so its membership is diffed and enforced.
  await order.Items.populate();
  order.Items.remove((item) => item.Sku === 'OBSOLETE');

  await order.save();
}
```

`remove` — like `set`, `union`, `diff` and `intersection` — only edits the in-memory list; the
`save()` above is what applies the removal, under the orphan policy below. Passing a model rather
than a predicate matches by primary key. See
[07](07-relations.md#set-operations).

## Identity map

Before anything else, every model reached is canonicalized: a row reached by two relation paths
yields **one instance**, and therefore one subject rather than two conflicting ones.

It is keyed by `(table name, primary key)` — not by constructor. A `@DiscriminationMap` produces
several constructors for one table, and a subclass instance is still the same row.

Key rendering (`identityKey`) is type-tagged so `1` and `'1'` never collide, handles `Buffer`
keys as hex, and length-prefixes each part of a composite tuple so `[1, 2]` and `['1,2']` cannot
alias. A key with any part missing renders as `null` and the model is not registered — it has no
identity yet.

It is **not a cache**. Nothing outside a `save()` consults it, and it is discarded with the
transaction. Saves nested inside one transaction share it, so a row touched by two of them is
still one object.

## Classification

Each collected model becomes a `Subject` with one operation:

| Operation | When |
| --- | --- |
| `Insert` | `model.IsNew` — never in the database. |
| `Update` | `model.IsDirty` — the snapshot diff is non-empty. |
| `None` | Nothing changed. |

Classification is deliberately **not** keyed on the primary key: `setDefaults()` pre-fills
`@Uuid` keys at construction, so a brand-new model can already have one.

## Deltas

Alongside subjects, the builder records:

**`IRelationDelta`** per populated `hasMany`: `Added` (members with no snapshot), `Kept`
(members that had one), `RemovedKeys` (keys in the snapshot that are gone from the array).

Both added *and* kept members receive the owner's foreign key as pending. That is what makes
re-parenting work: a clean child moved to another owner has its key rewritten and is promoted
from a no-op to an `UPDATE`.

**`IJunctionDelta`** per populated `manyToMany`. Only the *junction row* is created or
destroyed. A newly-linked target gets its own insert subject from the graph walk; an unlinked
target is left completely alone — removing a tag from an order must never delete the tag.

**`IOrphanDelta`** per `hasMany` removal — see below.

## Orphan policy

What happens to a row removed from a `hasMany`.

| Policy | Effect |
| --- | --- |
| `nullify` (default) | Clear the child's foreign key, leaving the row. |
| `delete` | Delete the child row. |
| `soft-delete` | Stamp the child's `@SoftDelete` column. Requires the target to have one. |
| `disable` | Do nothing; you manage orphans yourself. |

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation, OrphanPolicy } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<OrderItem, Order>;
}
```

### When no policy is declared

The default is `nullify`. But when the child's foreign key **demonstrably cannot hold NULL** —
the column is present in the target descriptor, was reflected from the database (non-empty
`NativeType`), and is declared non-nullable — `nullify` cannot work either, and the ORM
**throws**:

```
relation Items on OrderItem removes rows whose foreign key order_id is NOT NULL, so the
default orphan policy 'nullify' cannot be applied. Declare what should happen explicitly:
@HasMany(..., { orphan: OrphanPolicy.Delete }) to remove the row, OrphanPolicy.SoftDelete to
stamp it, or OrphanPolicy.Disable to leave it alone. Removing rows is never inferred from
schema nullability.
```

An earlier version silently escalated to `DELETE`. It throws now on the reasoning that a
`nullify` the database rejects is a loud, recoverable failure, while a wrong `DELETE` is not.

The `NativeType` check matters in the other direction too: `_prepareColumnDesc` defaults
`Nullable` to `false`, so without it every model whose table info has not loaded would become a
hard error.

`soft-delete` on a target with no `@SoftDelete` column throws at resolution time.

### Re-parenting is not orphaning

Orphans are computed once over the **whole set**, not per relation, because the decision needs
global information. Every removed key that has a live subject of the same target table
elsewhere in the graph is subtracted — moving a child from one owner to another is a re-parent,
and only a set-wide view can tell the two apart.

### `delete` degrades to `soft-delete`

An orphan policy of `delete` on a model that declares `@SoftDelete` is applied as `soft-delete`.
`ModelBase.destroy()` has always stamped rather than deleted for such a model; letting an orphan
take the other branch would make "delete this row" depend on which code path reached it.

`OneToManyRelationList.sync()` degrades the same way for the same reason: the rows it drops from
a relation targeting a `@SoftDelete` model are stamped, not deleted. See
[07](07-relations.md#relation-objects-at-runtime).

## Ordering

`SubjectSorter` runs Kahn's algorithm over the insert subjects in O(V + E), producing an order
where every parent precedes every child that references it. It is **stable**: a dependency-free
graph comes out exactly as it went in.

In-degree counts **distinct** targets — two foreign keys on one subject pointing at the same
parent are one dependency, and double-counting would leave a counter that never reaches zero
and a spurious cycle report.

### Cycles

When nothing can proceed, the sorter tries `deferSelfReferences`: foreign keys pointing at the
**same table** (a self-referencing hierarchy — a cycle between models but not between rows) are
moved to `DeferredForeignKeys`. The row is inserted without that column and a follow-up `UPDATE`
sets it.

A genuine cycle between two different models cannot be broken this way and throws
`OrmCycleException`:

```
cannot order INSERTs: foreign-key cycle between models A -> B. Break the cycle by saving one
side first, or make one of the foreign keys deferrable by pointing it at the same model.
```

Orphan deltas are ordered children-before-parents, so a `DELETE` never strands a foreign key.

## Execution

`SubjectExecutor` runs four phases in order: **inserts → updates → junctions → orphans**.

Every statement goes through `createQuery`, so table naming, schema qualification and identifier
escaping match the ActiveRecord paths. No connection is threaded by hand — `transaction()`
carries it in `AsyncLocalStorage`.

### Inserts

**One statement per row, deliberately, and not subject to `chunk`.** A batched multi-row insert
can only return keys where the dialect supports `RETURNING` or `insertIdIsFirstOfBatch` holds,
and a subject's key is needed by the very next subject in the order.

For each row: generate client-side keys, assert `assigned` keys, request `RETURNING` when an
`auto` key needs to come back and the dialect supports it, then backfill.

The insert payload starts from `model.toSql()`, drops every deferred foreign-key column, then
overwrites each pending foreign key from its target's now-known join-column value
(`IPendingForeignKey.JoinColumn`). That overwrite matters: `StandardModelToSqlConverter` already
wrote the column from the relation object, and for a target inserted moments ago that value was
`undefined` at serialization time.

Backfill uses `setPkValue`, not the `PrimaryKeyValue` setter — the setter's `One` branch also
writes the new key onto the owner's `SingleRelation` wrapper, which persists nothing.

### Updates

The update payload resolves pending **and** deferred foreign keys onto the model first, *then*
re-reads `changeSet()`. This is the single place that decides whether a row really changed:
a re-parented child that was clean when subjects were built is caught here and nowhere else.

An empty payload emits nothing. Primary key columns are excluded from the `SET` list. `@UpdatedAt`
is stamped when something is written.

Subjects classified `None` that carry a pending foreign key are included in the update phase for
exactly this reason — excluding them would lose the move.

### Junctions

Rows are written **column-first** rather than through the junction model, so a junction model is
not required to declare `@BelongsTo` on both sides (which `ManyToManyRelationList.update()` does
require).

Inserts run before deletes, so re-linking the same pair inside one save cannot momentarily
violate a unique constraint on the junction table.

Both are batched by `chunk`.

### Orphans

`nullify` and `soft-delete` run first as `UPDATE`s, then `delete` runs as `DELETE`s. Batched by
`chunk`. These builders are unfiltered — `createQuery` only adds the `DeletedAt IS NULL` filter
to select builders — which is what stamping an already-soft-deleted row needs.

## `{ reload: true }`

Re-reads every already-persisted model's row inside the transaction, batched one `SELECT` per
model class, and performs a **three-way merge** between the hydration baseline, the model, and
the current row:

- a column **you edited** keeps your value and is rebased, so it is written;
- a column **you did not touch** is reset to the current database value on the model *and* in
  the baseline, so it drops out of the diff and is not written at all.

Moving only the baseline would do the opposite of the intent: the model would still hold the
stale value, the diff would report `current → stale`, and the `UPDATE` would clobber whatever
another process wrote. The model has to move too.

A row that has **disappeared** has its snapshot cleared, reclassifying the model as an `INSERT`
that re-creates it, rather than an `UPDATE` matching nothing.

This is last-write-wins rebasing, **not conflict detection**. Two callers editing the same
column still race, and neither is told.

## Single-connection constraint

```
save() cannot span connections: Order is on connection main but Log is on connection audit.
Save each connection's graph separately.
```

The transaction covers one connection; committing half a graph is not an option.

## After a successful save

`resnapshotRelations` re-records every populated relation's member keys, so a second `save()` on
the same graph sees no membership change and emits nothing. `Query` and `Virtual` relations are
skipped.

## Driving the pieces directly

The executor deliberately does **not** open the transaction — `UnitOfWork` does — so you can
drive the pipeline yourself, which is what the ORM's own tests do.

```ts sample
import { Connection, Model, ModelBase, Primary, SubjectBuilder, SubjectSorter, SubjectExecutor, IdentityMap } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Reference: string;
}

export async function inspectPlan(root: Order) {
  const builder = new SubjectBuilder(new IdentityMap());

  const models = builder.collect(root);
  const set = builder.buildFrom(models);
  const plan = new SubjectSorter().sort(set);

  // What would run, without running it.
  const summary = {
    inserts: plan.Inserts.map((s) => s.Identity),
    updates: plan.Updates.map((s) => s.Identity),
    junctions: plan.Junctions.length,
    orphans: plan.Orphans.length,
    empty: set.IsEmpty,
  };

  // And then, if you want to execute it — inside your own transaction.
  const result = await new SubjectExecutor({}).execute(plan);

  return { summary, result };
}
```

`Subject.Identity` renders as `Model#key`, or `Model#<new>` before the key exists. It is for
diagnostics only and is never used as a map key.

# Relations

Five relation types, declared by decorator and materialised at runtime as relation objects
hanging off the model instance.

| Decorator | `RelationType` | Runtime object | Shape |
| --- | --- | --- | --- |
| `@BelongsTo` / `@ForwardBelongsTo` | `One` | `SingleRelation` | This row points at one other row |
| `@HasMany` | `Many` | `OneToManyRelationList` | Other rows point at this one |
| `@HasManyToMany` | `ManyToMany` | `ManyToManyRelationList` | Linked through a junction table |
| `@Query` | `Query` | `ManyQueryRelationList` | Populated by a custom query |
| `@Virtual` | `Virtual` | your own `Relation` subclass | Populated however you like |

## `@BelongsTo(target, foreignKey?, primaryKey?)`

The owning side of a one-to-one / many-to-one. The **foreign key lives on this model**.

- `foreignKey` defaults to the lowercased property name plus `_id` — property `Owner` → `owner_id`.
- `primaryKey` defaults to the **target** model's primary key.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('companies')
export class Company extends ModelBase<Company> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public company_id: number;

  /** Defaults: foreign key `company_id`, target key `Id`. */
  @BelongsTo(Company)
  public Company: SingleRelation<Company>;

  /** Explicit — joins users.company_code to companies.Code. */
  @BelongsTo(Company, 'company_code', 'Code')
  public CompanyByCode: SingleRelation<Company>;
}
```

### Naming the target as a string

Passing a model **name** instead of a class breaks import cycles. The target is resolved by
`Orm.resolve()`'s `wireRelations()` step, and the default primary key is read lazily through a
property accessor.

In a real project `Client` and `Order` live in separate files that import each other. The file
that would close the cycle uses `import type`, which erases at compile time, and names its
relation target as a string so nothing is dereferenced at decoration time:

```ts
// order.ts
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
// Type-only: a VALUE import back to Client would close the cycle and throw
// `Cannot access 'Client' before initialization` while the decorator runs.
import type { Client } from './client.js';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public client_id: number;

  @BelongsTo('Client', 'client_id', 'Id')
  public Client: SingleRelation<Client>;
}
```

```ts sample
// client.ts — imports order.ts as a value, which is fine: only one side may do so.
import { Connection, Model, ModelBase, Primary, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public client_id: number;

  @BelongsTo('Client', 'client_id', 'Id')
  public Client: SingleRelation<Client>;
}

@Connection('default')
@Model('clients')
export class Client extends ModelBase<Client> {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany('Order', { foreignKey: 'client_id', primaryKey: 'Id' })
  public Orders: Relation<Order, Client>;
}
```

Both `'Client'` and `'Order'` are resolved to real classes by `Orm.resolve()`'s `wireRelations()`
step. A name that matches no registered model throws
`type X not found for relation R in model M`.

### `@ForwardBelongsTo(forwardRef(() => Target), foreignKey?, primaryKey?)`

The other cycle-breaker: a lazily-evaluated class reference.

```ts sample
import { Connection, Model, ModelBase, Primary, ForwardBelongsTo, forwardRef, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('nodes')
export class TreeNode extends ModelBase<TreeNode> {
  @Primary()
  public Id: number;

  public parent_id: number;

  @ForwardBelongsTo(forwardRef(() => TreeNode), 'parent_id', 'Id')
  public Parent: SingleRelation<TreeNode>;
}
```

Note `@ForwardBelongsTo` derives its default `primaryKey` from the **source** model, unlike
`@BelongsTo` which uses the target's. Pass it explicitly when the two differ.

### Composite keys

A relation's `PrimaryKey` and `ForeignKey` each name exactly **one** column, because the join
compiler emits a one-column `ON` predicate. A model with a composite primary key therefore has
no defensible default, and the decorator throws at decoration time:

```
relation R cannot default its join column: model M has a composite primary key (A, B).
Pass primaryKey explicitly.
```

Name the column yourself.

## `@HasMany(target, options?)`

The inverse side. The **foreign key lives on the target model**.

| Option | Default | Meaning |
| --- | --- | --- |
| `foreignKey` | `<sourceModelName>_id`, lowercased | Column on the target pointing back here. |
| `primaryKey` | This model's primary key | Column on this model the target points at. |
| `orphan` | see [08](08-unit-of-work.md) | What `save()` does with a removed child. |
| `type` | `OneToManyRelationList` | Custom relation class. |
| `factory` | — | Custom relation factory function. |

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation, OrphanPolicy } from '@spinajs/orm';

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
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Reference: string;

  @HasMany(OrderItem, {
    foreignKey: 'order_id',
    primaryKey: 'Id',
    orphan: OrphanPolicy.Delete,
  })
  public Items: Relation<OrderItem, Order>;
}
```

## `@HasManyToMany(junctionModel, targetModel, options?)`

Many-to-many through an explicit junction model.

| Option | Default | Meaning |
| --- | --- | --- |
| `sourceModelPKey` | This model's primary key | Column on this model. |
| `targetModelPKey` | Target's primary key | Column on the target. |
| `junctionModelSourcePk` | `<sourceModelName>_id` | Junction column pointing at this model. |
| `junctionModelTargetPk` | `<targetModelName>_id` | Junction column pointing at the target. |
| `joinMode` | — | `'LeftJoin'` or `'RightJoin'`, when the right side may be absent. |
| `orphan` | `nullify` | Governs the **target** row. The junction row is always deleted. |

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, HasManyToMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('locations')
export class Location extends ModelBase<Location> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('offer_location')
export class OfferLocation extends ModelBase<OfferLocation> {
  @Primary()
  public Id: number;

  public Offer_id: number;

  public Localisation: number;

  // Found by target-model constructor, so the property name is free — `Location`, `Place`,
  // anything.
  @BelongsTo(Location, 'Localisation')
  public Location: SingleRelation<Location>;
}

@Connection('default')
@Model('offer')
export class Offer extends ModelBase<Offer> {
  @Primary()
  public Id: number;

  public Name: string;

  @HasManyToMany(OfferLocation, Location, {
    sourceModelPKey: 'Id',
    targetModelPKey: 'Id',
    junctionModelSourcePk: 'Offer_id',
    junctionModelTargetPk: 'Localisation',
  })
  public Localisations: Relation<Location, OfferLocation>;
}
```

Two constraints worth knowing before you design the junction:

- The junction model must declare a `@BelongsTo` to **each** side — one pointing at the source
  model, one at the target. Their property names are yours to choose: both the lazy `populate()`
  path and the junction writer locate them by comparing each junction relation's `TargetModel`
  **constructor** with the model being looked for, never by class name (which would not survive
  minification anyway). A junction missing one of them throws `junction model J of relation R
  declares no relation targeting T; add a @BelongsTo for it`.
- A junction table carries one foreign key column per side, so it cannot address a **composite**
  target key. `_dbDiff` throws rather than delete the wrong rows.

## `@Recursive()`

Applied on top of a relation, it marks it as hierarchical — populating loads the whole chain
using a recursive CTE rather than one level.

It must come **after** the relation decorator in evaluation order (so, written above it), or it
throws `cannot set recursive on not existing relation`.

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Recursive, Relation } from '@spinajs/orm';

@Connection('default')
@Model('category')
export class Category extends ModelBase<Category> {
  @Primary()
  public Id: number;

  public parent_id: number;

  public Name: string;

  @Recursive()
  @HasMany('Category', { foreignKey: 'parent_id' })
  public Children: Relation<Category, Category>;
}
```

## `@Query(callback, mapper)`

A relation whose data does not come from a single foreign key — an aggregate, a union, anything
you can express as a query.

`callback` receives the owner rows and returns a select builder. `mapper` distributes the
results back onto each owner.

```ts sample
import { Connection, Model, ModelBase, Primary, Query, ManyQueryRelationList, ISelectQueryBuilder } from '@spinajs/orm';

@Connection('default')
@Model('audit_entries')
export class AuditEntry extends ModelBase<AuditEntry> {
  @Primary()
  public Id: number;

  public subject_id: number;

  public Message: string;
}

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;

  @Query<User, AuditEntry>(
    (owners) => AuditEntry.query().select('*').whereIn('subject_id', owners.map((o) => o.Id)) as ISelectQueryBuilder,
    (owner, rows) => rows.filter((r) => r.subject_id === owner.Id),
  )
  public Audit: ManyQueryRelationList<AuditEntry, User>;
}
```

A query relation is always considered populated. Every mutating method on it — `remove`, `sync`,
`update`, `set`, `union`, `diff`, `intersection`, `populate` — throws.

## `@Virtual(relationClass?)`

Hands relation loading entirely to a class you write. Without an argument the class is read from
the property's `design:type` metadata.

## `@Historical(target)`

Declares a `Many` relation to a history table, with the foreign key and primary key both
defaulting to this model's primary key. Pair it with `table.trackHistory()` in the migration and
the `HistoricalModel` interface (`__action__`, `__revision__`, `__start__`, `__end__`).

## Relation objects at runtime

### `SingleRelation<R, O>` — the `One` side

| Member | Meaning |
| --- | --- |
| `Value` | The related model, `null`, or `undefined` when not loaded. |
| `Populated` | Whether it has been loaded. |
| `attach(obj \| null)` | Point at a model and write the owner's foreign key to match (the target's join-column value, or NULL; a query relation has no foreign-key column to write). No database access; the owner's `changeSet()` then reports the key. |
| `detach()` | `attach(null)`. |
| `set(obj)` | `attach` + `owner.update()`, in one transaction. |
| `remove()` | Delete the related row and clear the foreign key, in one transaction. |
| `populate(callback?)` | Load it. |

`populate()` queries the **target table filtered on the relation's declared join column**, not
necessarily the target's own primary key — `@BelongsTo` takes an explicit third argument for
exactly this case. It uses `first()` when the owner's foreign key column is nullable and
`firstOrFail()` when it is not.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('companies')
export class Company extends ModelBase<Company> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public company_id: number;

  @BelongsTo(Company, 'company_id', 'Id')
  public Company: SingleRelation<Company>;
}

export async function single() {
  const user = await User.getOrFail(1);

  await user.Company.populate();
  const name = user.Company.Value?.Name;

  // Re-point without touching the database yet.
  const other = await Company.getOrFail(2);
  user.Company.attach(other);
  await user.update();

  // Or attach and persist in one transaction.
  await user.Company.set(other);

  return name;
}
```

### `Relation<R, O, Q>` — the list side

Extends `Array`, so `push`, `forEach`, `length` and iteration all work.

`Symbol.species` is `Array`, deliberately: methods that derive a new collection (`splice`,
`slice`, `concat`, `filter`) build a plain array rather than trying to construct a relation
without an owner. A slice of a relation is a list of models, not a relation.

| Member | Meaning |
| --- | --- |
| `Populated` | Whether it has been loaded. |
| `TargetModelDescriptor` | Descriptor of the related model. |
| `populate(callback?)` | Load members. |
| `set(models \| fn)` | Replace the contents. |
| `union(dataset, cmp?)` | Add the dataset's members, skipping the ones already present. |
| `remove(model \| models \| predicate)` | Remove matching members, returning the ones actually removed. |
| `empty()` / `clear()` | Drop every member. |
| `diff(dataset, cmp?)` | Symmetric difference against a dataset. |
| `intersection(dataset, cmp?)` | Members present in both. |
| `update()` | Insert-or-update every member that is `IsDirty` (new, or changed since it was loaded), in one transaction. |
| `sync()` | `update()`, then **remove from the database anything not in the list**. |

Every one of those except `update()` and `sync()` is **in-memory only** — `set`, `union`, `diff`,
`intersection`, `remove`, `empty` and `clear` alike. Nothing reaches the database until `sync()`,
`update()` or `save()` runs. See [Set operations](#set-operations) below.

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

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function lists() {
  const order = await Order.getOrFail(1);
  await order.Items.populate();

  order.Items.push(new OrderItem({ Sku: 'NEW-1' }));
  order.Items.remove((item) => item.Sku === 'OLD-1');

  // Writes the additions AND deletes the removed row from the database.
  await order.Items.sync();

  // Or write additions/changes only, deleting nothing.
  await order.Items.update();
}
```

`OneToManyRelationList._update()` assigns each member's foreign key **before** filtering on
`IsDirty`. A child re-parented onto this owner needs its key rewritten and persisted; filtering
first would leave a previously-clean child holding its old foreign key, and a following `sync()`
would then delete it as "not belonging" here.

`OneToManyRelationList.sync()` then disposes of the orphans — the rows still pointing at this
owner that are no longer in the list. When the target model declares `@SoftDelete` they are
**stamped** (`DeletedAt = now`) rather than deleted, and only rows not already stamped are
touched, so a second `sync()` leaves the original deletion time alone. This is the same
degradation `SubjectExecutor.effectivePolicy` applies on the `save()` path — see
[08](08-unit-of-work.md). A target without `@SoftDelete` is hard-deleted, as before.

`ManyToManyRelationList._update()` is idempotent. It first reads the junction rows that already
exist for this owner, then per member: inserts the member when it has no primary key — a junction
row written for a keyless model would carry a NULL foreign key — and skips writing the junction
row entirely when the pair is already linked. The junction's own primary key is auto-generated,
so re-inserting a linked pair would *duplicate* the link rather than upsert it, which is what
repeated `sync()` calls used to do. A primary key of `0` is a real key here, not "unsaved".

`ManyToManyRelationList.populate()` resolves the junction property holding the target the same way
`_update()` does, by constructor identity, and skips junction rows whose target row no longer
exists rather than pushing `null` into the member list.

`OneToManyRelationList.populate()` pushes the loaded rows into the list itself rather than routing
them through `Owner.attach()`. Attaching would feed every sibling relation declared against the
same target model, and drop `@DiscriminationMap` subclass rows whose constructor is not the
declared target. The one thing attach does that is worth keeping is kept: each loaded child gets
its back-reference to the owner set, when it declares one.

### Set operations

`set`, `union`, `diff`, `intersection` and `remove` are pure **in-memory** operations on the
member list. None of them issues a statement; the database changes when `sync()`, `update()` or
`save()` runs.

`diff` and `intersection` return a new array and leave the relation untouched — apply the result
with `set()`. `union` and `remove` write straight back into the relation. `remove` returns only
the members it actually removed, and matches a model (or an array of models) **by primary key**,
not by object identity; the predicate form is unaffected.

```ts
// Matched by primary key — `existing` need not be the very instance in the list.
const removed = order.Items.remove(existing);

// Adds only what is not already there.
order.Items.union([extraItem]);

// Compute, then apply.
order.Items.set(order.Items.diff(incoming));

// Only now does anything reach the database.
await order.Items.sync();
```

#### How members are compared

Without a comparator every operation compares by **primary key**, with two rules:

- A composite key is flattened into a single string before comparison. Passing the key array to
  lodash directly would be read as a property *path* (`obj['TenantId']['Code']`), making every
  row compare equal.
- A model whose key is not set — a freshly constructed, never-inserted one — is compared **by
  reference**. Two fresh models are always two members, never collapsed into one, and a fresh
  model never equals a persisted row.

Each operation takes an optional comparator instead:

```ts
order.Items.union(incoming, (a, b) => a.Sku === b.Sku);
const common = order.Items.intersection(incoming, (a, b) => a.Sku === b.Sku);
```

A model that declares **no primary key columns at all** has nothing to compare by, so a
comparator is mandatory for `diff`, `intersection` and `union` (and their `Dataset` equivalents).
Without one they throw `OrmException` rather than silently match nothing — or everything:

```
set operation compares by primary key, but the model declares no primary key columns; pass an
explicit comparator callback
```

`remove` takes no comparator and does not throw here; against a keyless model it degrades to
reference matching.

#### `union` de-duplicates

`union` skips members already present, comparing by primary key or by the comparator. The
**instance already in the relation wins** over the incoming duplicate, so pending edits on it are
not discarded, and duplicates *within* the incoming dataset collapse too. Unsaved models compare
by reference and are therefore always appended.

```ts
const kept = order.Items[1];                    // Id 2
order.Items.union([new OrderItem({ Id: 2 }), new OrderItem({ Id: 3 })]);
// -> Ids [1, 2, 3]; order.Items[1] is still `kept`
```

#### `Dataset` — the same algebra, standalone

`Dataset.diff`, `Dataset.intersection` and `Dataset.union` each return a closure of exactly the
shape `set()` accepts, `(members, primaryKeyColumns) => members`. They are what the relation
methods call, exported so a result can be computed and applied in one step:

```ts
import { Dataset } from '@spinajs/orm';

order.Items.set(Dataset.union(incoming));
order.Items.set(Dataset.diff(incoming));
order.Items.set(Dataset.intersection(incoming, (a, b) => a.Sku === b.Sku));
```

`rel.union(dataset, cmp?)` is exactly `rel.set(Dataset.union(dataset, cmp?))`. All three are
in-memory, and all three obey the comparison rules above.

## Eager loading with `populate()`

`SelectQueryBuilder.populate()` is the eager path. It accepts several shapes:

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('companies')
export class Company extends ModelBase<Company> {
  @Primary()
  public Id: number;

  public Name: string;
}

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

  public company_id: number;

  @BelongsTo(Company, 'company_id', 'Id')
  public Company: SingleRelation<Company>;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function eager() {
  // By name.
  const one = await Order.select().populate('Items');

  // Several at once.
  const several = await Order.select().populate(['Items', 'Company']);

  // By target model class.
  const byClass = await Order.select().populate(Company);

  // With a callback constraining the relation's own query.
  const filtered = await Order.select().populate('Items', function () {
    this.where('Sku', 'like', 'ABC-%').orderBy('Sku');
  });

  // Nested, dotted-path form.
  const nested = await Order.select().populate('Items.Order.Company');

  return { one, several, byClass, filtered, nested };
}
```

Relation lookup by name is case-insensitive and trimmed, for backward compatibility.

### How eager loading actually runs

`populate()` resolves an `IOrmRelation` for the relation type — `BelongsToRelation`,
`OneToManyRelation`, `ManyToManyRelation`, `BelongsToRecursiveRelation`, `QueryRelation` or
`VirtualRelation` — and calls `execute()` on it.

- **`One`** compiles into a `LEFT JOIN` on the main query, so the related row arrives on the same
  row and is attached by `OneToOneRelationHydrator` during hydration.
- **`Many`** and **`ManyToMany`** register an `IBuilderMiddleware` that issues a follow-up query
  in `afterHydration`, keyed on the parent keys just loaded.
- **Recursive** relations use a `WITH RECURSIVE` CTE.

A `One` relation nested under a `OneToManyRelation` deliberately does not inherit the parent
relation, to keep column aliases and hydration separate.

## Loading a relation without an instance

`Model.populate(relationName, owner)` builds the query directly. The owner may be a model or a
bare key.

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation } from '@spinajs/orm';

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

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function staticPopulate() {
  return await Order.populate('Items', 1);
}
```

`Query` and `Virtual` relations throw here — only `One`, `Many` and `ManyToMany` are supported.

## Custom relation classes

Both `@HasMany` and `@HasManyToMany` accept `type` (a class) or `factory` (a function) to
replace the default relation object.

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, OneToManyRelationList } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;

  public Quantity: number;

  public UnitPrice: number;
}

export class ItemList extends OneToManyRelationList<OrderItem, Order> {
  public get Total(): number {
    return [...this].reduce((sum, item) => sum + item.Quantity * item.UnitPrice, 0);
  }
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id', type: ItemList })
  public Items: ItemList;
}
```

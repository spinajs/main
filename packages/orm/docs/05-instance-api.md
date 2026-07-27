# Instance API

Everything on a `ModelBase` instance: construction, dirty tracking, the four write paths, and
serialization.

## Construction

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

export function construct() {
  const blank = new User();
  const filled = new User({ Email: 'a@example.com', Name: 'A' });

  return { blank, filled };
}
```

The constructor does three things:

1. `setDefaults()` — assigns each column its reflected `DefaultValue`, generates `@Uuid` columns
   and `uuid`-strategy primary keys, stamps `@CreatedAt`, and instantiates a relation object for
   every declared relation.
2. Hydrates the argument, when given.
3. **Returns a `Proxy`.** Writing a property that is a known column sets `IsDirty` and records
   the name. This is why `new User()` returns something that is not quite the raw instance.

The generic parameter (`ModelBase<User>`) types the constructor's `data` argument. It is
optional; `extends ModelBase` works, but you lose that typing.

## Identity

### `ModelDescriptor`

The model's descriptor, read fresh from class metadata each access.

### `Container`

The DI container of this model's connection — the driver owns a child container holding the
dialect's statements, compilers and converters. Throws if the connection is unknown.

### `PrimaryKeyName: string[]`

Key column names.

### `PrimaryKeyValue`

A **scalar** for a single-column key, a **tuple in key order** for a composite one.

Assigning it also cascades into loaded relations: a `One` relation's foreign key is rewritten,
and every member of a `Many` relation gets the new value. Cascading is **skipped for composite
keys** — a relation names one column and cannot carry a tuple.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('composite_table')
export class TenantRecord extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;
}

export function keys() {
  const record = new TenantRecord();

  record.PrimaryKeyValue = [1, 'AB'];         // tuple, in declaration order
  record.PrimaryKeyValue = { TenantId: 1, Code: 'AB' }; // or keyed by column

  return record.PrimaryKeyValue;              // [1, 'AB']
}
```

`valueOf()` returns `PrimaryKeyValue`, so a model coerces to its key in numeric contexts.

## Dirty tracking and snapshots

Two independent mechanisms, and the difference matters.

**`IsDirty` / `__dirty_props__`** — the proxy records a property as dirty on *any* write,
including one that puts the original value straight back.

**The snapshot** — a baseline captured when the instance was hydrated from a database row.
`changedColumns()` diffs against it, so a column written `A → B → A` reports no change.

`update()` and `save()` both build their payload from the **snapshot diff**, not the dirty list,
because the diff is the more precise answer.

| Member | Meaning |
| --- | --- |
| `Snapshot` | The baseline, or `null` for a model never loaded from the database. Read-only. |
| `takeSnapshot()` | Capture current column values as the baseline. Values are **copied**, never aliased. |
| `snapshotRelation(name)` | Record the current member primary keys of one relation. No-op without a snapshot. |
| `clearSnapshot()` | Discard the baseline. The model is then treated as brand new — an INSERT. |
| `changedColumns()` | Columns differing from the baseline. With no baseline, **every** column. |
| `markDirty(prop)` | Record a column as changed and set `IsDirty`. |

`Snapshot === null` — not the absence of a primary key — is what classifies a model as an
INSERT. That distinction exists because `setDefaults()` pre-fills `@Uuid` keys at construction,
so a brand-new model can perfectly well have a key already.

`markDirty` is the supported way for a relation object to report that it rewrote one of the
owner's foreign keys. It matters because `SingleRelation.attach()` stores the new target on the
relation wrapper but never writes the column on the model — the value is materialised later by
`StandardModelToSqlConverter`. Without `markDirty`, `changedColumns()` would compare the column
against its snapshot, find it untouched, and emit nothing.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function tracking() {
  const user = await User.getOrFail(1);   // hydrated => has a snapshot

  const originalName = user.Name;
  user.Name = 'Changed';
  user.Name = originalName;

  user.IsDirty;            // true  — the proxy saw two writes
  user.changedColumns();   // []    — net change is nothing

  await user.update();     // issues no statement
}
```

## Hydration and attachment

### `hydrate(data)`

Fills the model by running every registered `ModelHydrator`. See
[11-converters-and-hydration.md](11-converters-and-hydration.md).

### `attach(model)`

Places a related model into whichever relation targets its class, and sets the foreign key.

Matching is by **constructor identity**, not class name — name matching pushed a row into every
relation whose target happened to share a name, and broke under minification.

For a `Many` relation it also sets the child's back-reference when the child declares one. For
`ManyToMany` it does not: that link lives in the junction table, not on the target row.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;

  public Sku: string;

  @BelongsTo('Order', 'order_id', 'Id')
  public Order: SingleRelation<Order>;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function attaching() {
  const order = await Order.getOrFail(1);

  // Pushes onto Items and sets the child's back-reference.
  order.attach(new OrderItem({ Sku: 'ABC-1' }));

  await order.save();
}
```

## Writing

### `insert(behaviour?)` → `Promise<IUpdateResult>`

Inserts this instance.

Client-side keys are generated and `assigned` keys asserted **before** any SQL is built, so a
missing `assigned` key fails with a clear message rather than a `NOT NULL` violation.

The generated key comes back via `RETURNING` when the dialect supports it and the key strategy
is `auto`; otherwise from the reported insert id — and only when the key is actually missing, so
a `uuid` or `assigned` key you supplied is never overwritten.

`RETURNING` is deliberately *not* requested for `InsertBehaviour.InsertOrUpdate`.

### `update(data?)` → `Promise<IUpdateResult>`

Writes only the columns that differ from the snapshot, plus any foreign key a relation reported
through `markDirty`. Primary key columns are excluded from the `SET` list.

When nothing changed it clears `IsDirty` and returns `{ RowsAffected: 0, LastInsertId: 0 }`
without touching the database.

When something *is* written and the model has `@UpdatedAt`, the column is stamped and added to
the change set. Afterwards `IsDirty` is cleared and a fresh snapshot is taken.

### `insertOrUpdate()` → `Promise<IUpdateResult>`

`update()` when `PrimaryKeyValue` is truthy, `insert()` otherwise. Note this uses plain
truthiness, so it does not do the careful tuple check `destroy()` does.

### `save(options?)` → `Promise<ISaveResult>`

Persists this model **and everything reachable from it** in one transaction. This is the unit of
work; it has its own page — [08-unit-of-work.md](08-unit-of-work.md).

### `destroy()` → `Promise<IUpdateResult>`

Deletes the row, or stamps the `@SoftDelete` column. Returns early without issuing anything when
any part of the primary key is unset — checked per element, because a composite key is a tuple
and a tuple is always truthy.

### `archive()` → `Promise<IUpdateResult>`

Stamps the `@Archived` column and writes the whole model. Throws when the model has no archive
column.

```ts sample
import { Connection, Model, ModelBase, Primary, InsertBehaviour } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

export async function writes() {
  const user = new User({ Email: 'a@example.com', Name: 'A' });
  await user.insert();
  user.Id;                              // assigned from RETURNING or the insert id

  user.Name = 'A renamed';
  await user.update();                  // UPDATE users SET Name = ? WHERE Id = ?

  await user.insertOrUpdate();          // has a key => update
  await user.destroy();

  const upserted = new User({ Email: 'a@example.com', Name: 'A again' });
  await upserted.insert(InsertBehaviour.InsertOrUpdate);
}
```

## Refreshing

### `fresh()` → `Promise<this>`

Re-reads the row and resolves a **new** instance. Filters on the primary key, falling back to
unique columns when the model has no key. Throws when the row is gone (`firstOrFail`).

### `refresh()` → `Promise<void>`

Re-reads the row and copies every column onto **this** instance, then clears `IsDirty`.

Note it copies columns only, and does not take a new snapshot — so the baseline still reflects
whatever was there before. Use `save({ reload: true })` when you need a properly rebased diff.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function refreshing() {
  const user = await User.getOrFail(1);

  const copy = await user.fresh();   // new instance
  await user.refresh();              // same instance, columns overwritten

  return { user, copy };
}
```

## Serialization

### `dehydrate(options?)`

Plain object of the model's **columns only**. Skips columns in `options.omit`, skips the
instance's `_hidden` list, and skips foreign keys managed by a relation unless they are also
primary keys. Runs each column's converter `toDB`.

It **throws** `Field X cannot be null` for a non-nullable, non-primary-key column holding
`null`, `undefined` or `''` — pass `ignoreNullable: true` to allow it.

### `dehydrateWithRelations(options?)`

Same, plus relations recursed. A `One` relation with no loaded value falls back to emitting the
raw foreign key. A `Many` relation with no members emits `[]`.

Note that `omit` is **not** propagated into nested relations — the recursive calls pass
`omit: []` deliberately, so an omission applies to the top level only.

### `toJSON()`

`dehydrate()` with no options. This is what `JSON.stringify(model)` calls.

### `toSql(onlyDirty?)`

The database-shaped payload, via `ModelToSqlConverter`. With `onlyDirty` it is narrowed to
`__dirty_props__` — the *dirty list*, not the snapshot diff.

`IDehydrateOptions`:

| Option | Meaning |
| --- | --- |
| `omit` | Field names to leave out. |
| `skipNull` | Drop `null` values. |
| `skipUndefined` | Drop `undefined` values. |
| `skipEmptyArray` | Drop empty arrays. |
| `ignoreNullable` | Do not throw on an unset non-nullable column. |
| `dateTimeFormat` | `'iso' \| 'sql' \| 'unix'` — passed through to the datetime converter. |

```ts sample
import { Connection, Model, ModelBase, Primary, Ignore } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  @Ignore()
  public Password: string;

  /** Never leaves the process. */
  protected _hidden: string[] = ['Password'];
}

export async function serializing() {
  const user = await User.getOrFail(1);

  const plain = user.dehydrate();
  const asJson = JSON.stringify(user);
  const partial = user.dehydrate({ omit: ['Email'], skipNull: true });
  const deep = user.dehydrateWithRelations({ dateTimeFormat: 'iso' });

  return { plain, asJson, partial, deep };
}
```

## Relation traversal

### `getFlattenRelationModels(recursive?)`

Every model held in this model's relations as a flat array. With `recursive: true` it walks the
whole graph.

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation } from '@spinajs/orm';

@Connection('default')
@Model('nodes')
export class Node extends ModelBase<Node> {
  @Primary()
  public Id: number;

  public parent_id: number;

  @HasMany('Node', { foreignKey: 'parent_id', primaryKey: 'Id' })
  public Children: Relation<Node, Node>;
}

export async function walk() {
  const root = await Node.getOrFail(1);
  await root.Children.populate();

  const direct = root.getFlattenRelationModels();
  const everything = root.getFlattenRelationModels(true);

  return { direct, everything };
}
```

## `driver()`

The `OrmDriver` for this model's connection.

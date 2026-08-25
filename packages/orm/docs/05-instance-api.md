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
3. That is all. A model is a plain instance — there is no `Proxy` and no write observer. Change
   detection is a diff against the snapshot, described under *Dirty tracking and snapshots*.

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

One mechanism: the **snapshot**, a value copy of every persisted column taken when the row was
last read from or written to the database. Everything else is derived from it on demand.

| Member | Meaning |
| --- | --- |
| `Snapshot` | The baseline, or `null` for a model that has never been in the database. Read-only. |
| `IsNew` | `Snapshot === null`. This — not the absence of a primary key — is what classifies a model as an INSERT, because `setDefaults()` pre-fills `@Uuid` keys at construction. |
| `IsDirty` | `IsNew`, or at least one column differs from the baseline. Derived on every read; no setter. |
| `changes()` | `{ Column, OldValue, NewValue }` for every column that differs, in descriptor order, followed by any `@BelongsTo` foreign key re-pointed through its relation. On an `IsNew` model: every column, `OldValue: undefined`. |
| `takeSnapshot()` | Capture current column values as the baseline. Values are **copied**, never aliased. |
| `snapshotRelation(name)` | Record the current member primary keys of one relation. No-op without a snapshot. |
| `clearSnapshot()` | Discard the baseline. The model is then `IsNew` again — an INSERT. |

Because nothing observes writes, the diff is exact: a column written `A → B → A` is not a change,
a `DateTime` re-created from the same instant is not a change, and an in-place mutation of a JSON
column (`model.Tags.push('x')`) **is** one. `snapshotEquals` compares `DateTime` by instant,
`Buffer` by bytes and objects by deep equality; a converter can supply its own hooks
(`11-converters-and-hydration.md`).

`IsDirty` costs one comparison per column until the first difference, and `changes()` compares
every column. Call `changes()` once and reuse the result rather than polling `IsDirty` in a loop
over models with large JSON columns.

Every write path re-baselines after its statement ran — `insert()`, `update()`, `archive()`,
`refresh()` and `save()` all end with a fresh snapshot — and only after: a statement that throws
leaves the model as dirty as it was, so a retry writes the same columns. `takeSnapshot()` is
public for the rare case where a caller must re-baseline by hand (narrowing a loaded user's roles
before handing it to a controller, say); calling it on a model that was never inserted makes
`save()` emit an UPDATE for a row that does not exist.

A `@BelongsTo` whose relation holds a target has its foreign key decided by that target: the
value is read off the relation's **join column** (`Relation.PrimaryKey` — the target's primary
key unless `@BelongsTo` names another column), it overrides a direct write of the raw column, and
it is what `toSql()`, the diff and the unit of work's pending keys all use.
`SingleRelation.attach()` also writes the owner's column to match (the join value, or `NULL` on
`detach()`), and after every successful write the ORM reconciles the foreign-key columns with
their relations before taking the fresh snapshot — so a model is clean after `insert()`,
`update()`, `archive()` and `save()`, even when the target's key only came into existence during
the write. A relation that was never attached, or whose `populate()` found no row for the key the
row carries, decides nothing: the column stands, and reading is never a change.

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
  const user = await User.getOrFail(1);   // hydrated => has a snapshot, IsNew === false

  const originalName = user.Name;
  user.Name = 'Changed';
  user.changes();          // [{ Column: 'Name', OldValue: originalName, NewValue: 'Changed' }]

  user.Name = originalName;
  user.IsDirty;            // false — net change is nothing
  user.changes();          // []

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

Afterwards a fresh snapshot is taken — generated key included — so a following `update()` on the
same instance writes only what changed since.

Client-side keys are generated and `assigned` keys asserted **before** any SQL is built, so a
missing `assigned` key fails with a clear message rather than a `NOT NULL` violation.

The generated key comes back via `RETURNING` when the dialect supports it and the key strategy
is `auto`; otherwise from the reported insert id — and only when the key is actually missing, so
a `uuid` or `assigned` key you supplied is never overwritten.

`RETURNING` is deliberately *not* requested for `InsertBehaviour.InsertOrUpdate`.

### `update(data?)` → `Promise<IUpdateResult>`

Hydrates `data` when given, then writes the columns `changes()` reports — including a foreign key
re-pointed through a relation. Primary key columns are excluded from the `SET` list.

When nothing changed it returns `{ RowsAffected: 0, LastInsertId: 0 }` without touching the
database.

When something *is* written and the model has `@UpdatedAt`, the column is stamped and added to
the change set. Afterwards a fresh snapshot is taken.

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

Stamps the `@Archived` column and writes the whole model, then takes a fresh snapshot. Throws
when the model has no archive column.

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

Re-reads the row and copies every column onto **this** instance, then takes a fresh snapshot, so
the baseline is what the database holds. Use `save({ reload: true })` when you need the diff
against current database state without discarding your in-memory edits.

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

Plain object of the model's **columns only**. Skips columns in `options.omit`, skips everything
the model declares with `@Hidden()`, and skips foreign keys managed by a relation unless they are
also primary keys. Runs each column's converter `toDB`.

It **throws** `Field X cannot be null` for a non-nullable, non-primary-key column holding
`null`, `undefined` or `''` — pass `ignoreNullable: true` to allow it.

### `dehydrateWithRelations(options?)`

Same, plus relations recursed. A `One` relation with no loaded value falls back to emitting the
raw foreign key. A `Many` relation with no members emits `[]`. A relation marked `@Hidden()` is
dropped like any other hidden property.

Note that `omit` is **not** propagated into nested relations — the recursive calls pass
`omit: []` deliberately, so an omission applies to the top level only.

### `toJSON()`

`dehydrate()` with no options. This is what `JSON.stringify(model)` calls.

### `toSql(onlyDirty?)`

The database-shaped payload, via `ModelToSqlConverter`. With `onlyDirty` it is narrowed to the
columns `changes()` reports.

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
import { Connection, Model, ModelBase, Primary, Hidden } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  /** Never leaves the process. */
  @Hidden()
  public Password: string;
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

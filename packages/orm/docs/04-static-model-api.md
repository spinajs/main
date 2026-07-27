# Static model API

Every model class gains a set of static methods. They are **not** declared on `ModelBase` in any
working form — the versions there throw `Not implemented` and exist only to give TypeScript the
signatures. `Orm.resolve()` overwrites them by binding `MODEL_STATIC_MIXINS` onto each
registered model class.

The practical consequence: **a static call before `Orm` has resolved throws `Not implemented`.**

Most of these return a query builder rather than a promise. A builder is thenable, so `await`
executes it — but you can keep chaining until you do. Methods that return a `Promise` directly
are marked below.

## Metadata

### `getModelDescriptor(): IModelDescriptor`

The model's descriptor. Throws `OrmException` if the class has none (missing `@Model`).

### `getRelationDescriptor(name: string): IRelationDescriptor`

One relation's descriptor. The lookup is **case-insensitive and trims** the argument — a
backward-compatibility concession, not a design intent. Throws if the relation does not exist.

### `driver(): OrmDriver`

The driver for this model's connection. Throws if the connection name is not configured.

## Reading

### `query()`

A bare `SelectQueryBuilder` with **no columns selected**. Use it when you want to choose columns
yourself, or for joins and raw projections.

### `select()`

`query()` plus `select('*')`.

### `where(...)`

`select('*')` plus a where clause. Accepts every form the where builder does — see
[06-query-builder.md](06-query-builder.md).

```ts sample
import { Connection, Model, ModelBase, Primary, RawQuery } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;

  public Age: number;
}

export async function reading() {
  const byColumn = await User.where('Email', 'someone@example.com');
  const withOperator = await User.where('Age', '>', 30);
  const byObject = await User.where({ Name: 'Ada', Age: 36 });
  const nested = await User.where(function () {
    this.where('Age', '>', 18).orWhere('Name', 'like', 'A%');
  });
  const raw = await User.where(RawQuery.create('LENGTH(Name) > ?', [5]));

  return { byColumn, withOperator, byObject, nested, raw };
}
```

### `all(page?, perPage?)`

`select('*')`, with `take(perPage).skip(page * perPage)` applied when **both** arguments are
given and valid (`page >= 0`, `perPage > 0`). Pages are zero-based.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function paging() {
  const everyone = await User.all();
  const thirdPage = await User.all(2, 25); // rows 50..74
  return { everyone, thirdPage };
}
```

### `find(pks: any[])` → `Promise`

Rows for the given primary keys. Composite keys are passed as tuples.

### `findOrFail(pks: any[])` → `Promise`

Same, but throws when the result count does not match the requested count.

### `get(pk)` → `Promise`

One row by primary key, or `undefined`. Applies a deterministic ordering first (see *Ordering
fallback* below).

### `getOrFail(pk)` → `Promise`

Same, but throws `OrmNotFoundException` when missing.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('composite_table')
export class TenantRecord extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;

  public Name: string;
}

export async function keys() {
  const one = await TenantRecord.get([1, 'AB']);          // composite key as a tuple
  const many = await TenantRecord.find([[1, 'AB'], [2, 'CD']]);
  const strict = await TenantRecord.findOrFail([[1, 'AB']]);

  return { one, many, strict };
}
```

### `first(callback?)` / `last(callback?)` → `Promise`

The first / last row by the fallback ordering. The callback receives the where builder.

### `newest(callback?)` / `oldest(callback?)` → `Promise`

Ordered by the `@CreatedAt` column. Throws `OrmException` when the model has none.

### `count(callback?)` → `Promise<number>`

`COUNT(*)` aliased `count`, read back as raw data. Resolves `0` rather than `undefined` for an
empty result.

```ts sample
import { Connection, Model, ModelBase, Primary, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;

  public Total: number;

  @CreatedAt()
  public CreatedAt: DateTime;
}

export async function aggregates() {
  const latest = await Order.newest();
  const firstEver = await Order.oldest();

  const openCount = await Order.count(function () {
    this.where('Status', 'open');
  });

  const firstBigOne = await Order.first(function () {
    this.where('Total', '>', 1000);
  });

  return { latest, firstEver, openCount, firstBigOne };
}
```

### `exists(pk)` → `Promise<boolean>`

Selects only the key columns and reports whether a row came back.

### `whereExists(relationOrQuery, callback)` / `whereNotExists(relationOrQuery, callback)`

Correlated `EXISTS` / `NOT EXISTS`. Takes either a relation **name** or a ready sub-query.
Covered in [06-query-builder.md](06-query-builder.md).

## Writing

### `insert(data, behaviour?)` → `Promise`

Accepts a model instance, a plain object, or an array of either.

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

export async function writing() {
  await User.insert({ Email: 'a@example.com', Name: 'A' });

  // Bulk. An empty array short-circuits and issues no statement.
  await User.insert([
    { Email: 'b@example.com', Name: 'B' },
    { Email: 'c@example.com', Name: 'C' },
  ]);

  // Upsert behaviours — single rows only.
  await User.insert({ Email: 'a@example.com', Name: 'A2' }, InsertBehaviour.InsertOrUpdate);
  await User.insert({ Email: 'a@example.com', Name: 'A3' }, InsertBehaviour.InsertOrIgnore);
  await User.insert({ Email: 'a@example.com', Name: 'A4' }, InsertBehaviour.InsertOrReplace);
}
```

`InsertBehaviour`:

| Value | Effect |
| --- | --- |
| `None` (default) | Plain `INSERT`. |
| `InsertOrIgnore` | Skip the row when the key already exists. |
| `InsertOrUpdate` | `ON DUPLICATE KEY UPDATE` over every non-primary-key column. |
| `InsertOrReplace` | Replace the existing row. |

Passing anything other than `None` **with an array throws** — the behaviours are mixed-mode
inserts whose row-to-key mapping cannot be reconstructed.

#### Reading generated keys back

This is the subtlest part of the static insert path. After the statement runs, the ORM tries in
this order:

1. **`RETURNING`.** When the dialect supports it (`supportedFeatures().insertReturning`) and the
   model has an `auto` key, the insert asks for the key columns back and assigns them
   positionally. Authoritative.
2. **Single row, auto key.** One row means one identity value — safe to assign.
3. **Contiguous batch backfill.** Only when the dialect declares
   `insertIdIsFirstOfBatch` (MySQL/InnoDB does; MSSQL and SQLite do not), the key is a single
   `auto` column, the behaviour is `None`, the server reported `RowsAffected === rows.length`,
   and *no* input row carried an explicit key. Then `LastInsertId + index` is assigned.
4. **Otherwise nothing is assigned.** A dialect whose insert id names the last row, a batch
   mixing supplied and generated keys, or a statement that did not insert one row per input row
   cannot be mapped positionally. Re-select, or insert one at a time.

### `create(data)` → `Promise`

Constructs an instance, `insert()`s it, and resolves the instance — so you get the generated key.

### `getOrCreate(pk, data)` → `Promise`

Looks up by primary key (when `pk` is not `null`) **and** by every `Unique` column present in
`data`. Inserts and returns a new instance when nothing matched.

### `getOrNew(data?)` → `Promise`

Same search, but does **not** insert. The returned new instance has any auto-increment key
column stripped from the hydration data, so the database still assigns it.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('tags')
export class Tag extends ModelBase<Tag> {
  @Primary()
  public Id: number;

  /** Reflected as UNIQUE — getOrCreate/getOrNew search on it. */
  public Slug: string;

  public Label: string;
}

export async function upserts() {
  const persisted = await Tag.getOrCreate(null, { Slug: 'news', Label: 'News' });

  const draft = await Tag.getOrNew({ Slug: 'sport', Label: 'Sport' });
  draft.Label = 'Sports';
  await draft.insert();

  return { persisted, draft };
}
```

### `update(data)`

A bare `UpdateQueryBuilder` carrying the patch — **add your own `where`**. Passing a `ModelBase`
throws; use the instance's own `update()` for that.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;
}

export async function bulkUpdate() {
  await Order.update({ Status: 'archived' }).where('Status', 'closed');
}
```

### `destroy(pks)`

Deletes by primary key, or — when the model has `@SoftDelete` — updates the delete column
instead. Accepts a scalar, a tuple, or an array of either.

It **throws on `undefined`/`null` and on an empty array**. An unbounded `DELETE` is not
something you get by forgetting an argument; use `truncate()` when you mean the whole table.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('sessions')
export class Session extends ModelBase<Session> {
  @Primary()
  public Id: number;

  public Token: string;
}

export async function deleting() {
  await Session.destroy(42);
  await Session.destroy([1, 2, 3]);
  await Session.truncate();
}
```

### `truncate()`

Empties the table. Returns a `TruncateTableQueryBuilder`.

### `transaction(callback)` → `Promise`

Runs the callback inside a transaction on this model's connection, resolving with whatever the
callback returned. Nesting takes a savepoint — see [09-transactions.md](09-transactions.md).

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('accounts')
export class Account extends ModelBase<Account> {
  @Primary()
  public Id: number;

  public Balance: number;
}

export async function move(fromId: number, toId: number, amount: number) {
  return await Account.transaction(async () => {
    const from = await Account.getOrFail(fromId);
    const to = await Account.getOrFail(toId);

    from.Balance -= amount;
    to.Balance += amount;

    await from.update();
    await to.update();

    return to.Balance;
  });
}
```

### `populate(relation, owner)`

Builds a query that loads one relation for one owner, without going through an instance. The
owner may be a model or a bare key value. See [07-relations.md](07-relations.md).

Not every relation type is supported: `Query` and `Virtual` relations throw
`Query population for relation type ... is not supported yet`.

## Ordering fallback

`get`, `getOrFail`, `first`, `last`, `getOrCreate` and `getOrNew` apply a deterministic ordering
before taking a row, so "first" means something stable. `_prepareOrderBy` picks, in order: the
primary key, then unique columns, then the `@CreatedAt` column.

## The functional helpers

`fp.ts` exports small composable wrappers for pipeline-style code. They reject with
`ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED)` when a write reports no rows affected.

```ts sample
import { Connection, Model, ModelBase, Primary, _get_entity, _update, _insert, _delete } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function functional() {
  // `_get_entity` returns a THUNK — call it to run the fetch. That is what makes it
  // composable: the pipeline is assembled first and executed later.
  const fetchUser = _get_entity(1, User);

  // Fetch by id (or pass an instance, optionally refreshed with `fresh = true`), then update.
  const updated = await fetchUser().then(_update<User>({ Name: 'Renamed' }));

  const created = await _insert<User>()(new User({ Name: 'Fresh' }));
  const removed = await _delete<User>()(updated);

  return { updated, created, removed };
}
```

Note the asymmetry: `_update` and `_insertOrUpdate` resolve the model even when nothing was
written, because a clean model short-circuits to `RowsAffected: 0` and that is a successful
no-op. `_insert` and `_delete` treat `RowsAffected <= 0` as a failure. `uuid` and `assigned`
keys report `LastInsertId: 0` on a *successful* insert, so only `RowsAffected` is meaningful
there.

## Statics added by other packages

`@spinajs/orm-http` installs `filter()`, `filterColumns()` and `filterSchema()` onto every model
during its own bootstrap. See [orm-http's docs](../../orm-http/docs/03-filtering.md).

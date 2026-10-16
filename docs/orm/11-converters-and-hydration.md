# Converters and hydration

Three separate mechanisms move data across the model / database boundary:

| Direction | Mechanism |
| --- | --- |
| Row → model | **Hydrators** (`ModelHydrator`), which call each column's converter `fromDB`. |
| Model → plain object | **Dehydrators** (`ModelDehydrator`), which call `toDB`. |
| Model → SQL payload | **`ModelToSqlConverter` / `ObjectToSqlConverter`**, which also call `toDB`. |

## Value converters

`IValueConverter` has two required methods and two optional ones.

```ts sample
import { ValueConverter, IColumnDescriptor, ModelBase } from '@spinajs/orm';

export class CsvConverter extends ValueConverter {
  /** Model value -> database value. */
  public toDB(value: string[], _model: ModelBase, _column: IColumnDescriptor, _options?: unknown): string | null {
    return value ? value.join(',') : null;
  }

  /** Database value -> model value. `raw` is the whole row. */
  public fromDB(value: string, _raw?: unknown, _options?: unknown): string[] {
    return value ? value.split(',') : [];
  }
}
```

### The snapshot hooks

`snapshotValue(value)` and `snapshotEquals(a, b)` are optional, and you need them **together**
whenever `fromDB` returns a **mutable instance of a class the ORM does not own**.

Without them the diff baseline can only either alias the live object — making the diff
permanently empty, so edits to that column are silently never written — or treat the column as
always-changed. The ORM takes the second, loud option; these hooks are how a converter opts into
a precise diff instead.

Immutable value types need neither: reference equality already answers the question.

```ts sample
import { ValueConverter, IColumnDescriptor, ModelBase } from '@spinajs/orm';

/** A mutable value object the ORM cannot copy on its own. */
export class Money {
  constructor(public Amount: number, public Currency: string) {}
}

export class MoneyConverter extends ValueConverter {
  public toDB(value: Money, _model: ModelBase, _column: IColumnDescriptor): string | null {
    return value ? `${value.Amount}:${value.Currency}` : null;
  }

  public fromDB(value: string): Money | null {
    if (!value) return null;
    const [amount, currency] = value.split(':');
    return new Money(Number(amount), currency);
  }

  /** Copy, never alias — an aliased baseline makes every diff empty. */
  public snapshotValue(value: Money | null): Money | null {
    return value ? new Money(value.Amount, value.Currency) : null;
  }

  public snapshotEquals(a: Money | null, b: Money | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.Amount === b.Amount && a.Currency === b.Currency;
  }
}
```

### Attaching a converter

Two routes.

**Per column, by decorator.** `@Json`, `@Set`, `@DateTime`, `@UniversalConverter`, `@Uuid`,
`@CreatedAt`, `@UpdatedAt`, `@SoftDelete` and `@Archived` all register into
`descriptor.Converters`.

**Per database type, by DI.** During `Orm.resolve()`, `registerDefaultConverters` maps native
type names into `__orm_db_value_converters__`:

| Key | Converter |
| --- | --- |
| `Date`, `DateTime` | `DatetimeValueConverter` |
| `Boolean`, `bool`, `Bool`, `boolean` | `BooleanValueConverter` |
| `Time`, `time`, `TimeSpan`, `timespan` | `TimeValueConverter` |

`reloadTableInfo()` then assigns a converter to any column that has none, matching on the
column's lowercased `NativeType`.

Decorator-declared converters win: they are applied first, and the type map only fills the gaps.

```ts sample
import { DI } from '@spinajs/di';
import { ValueConverter, IColumnDescriptor, ModelBase } from '@spinajs/orm';

export class PointConverter extends ValueConverter {
  public toDB(value: { x: number; y: number }, _m: ModelBase, _c: IColumnDescriptor): string {
    return `${value.x},${value.y}`;
  }

  public fromDB(value: string): { x: number; y: number } {
    const [x, y] = value.split(',').map(Number);
    return { x, y };
  }
}

/** Every column whose reflected NativeType is `point` now uses it. */
export function registerPointConverter() {
  DI.register(PointConverter).asMapValue('__orm_db_value_converters__', 'point');
}
```

### Built-in converters

| Converter | Behaviour |
| --- | --- |
| `JsonValueConverter` | `JSON.stringify` / `JSON.parse`. `fromDB` passes objects and arrays through untouched, so a native JSON column already parsed by the driver is safe. |
| `UuidConverter` | Writes a dashed UUID as a 16-byte `Buffer`; reads it back as the canonical 8-4-4-4-12 form. A value that is not 32 hex characters is returned as-is rather than mangled. |
| `UniversalValueConverter` | Reads the runtime type from a sibling column (`options.TypeColumn`, default `Type`) and converts accordingly. |
| `DatetimeValueConverter` | Abstract in core; dialects provide the implementation. |
| `TimeValueConverter` | Abstract in core; dialect-provided. |
| `BooleanValueConverter` | Abstract in core; dialect-provided. `0`/`1` ↔ boolean. |
| `SetValueConverter` | Abstract in core; dialect-provided. Emulates MySQL `SET`. |

`UniversalValueConverter` canonical forms: numbers as decimal text, booleans as `'true'` /
`'false'`, date / time / datetime as ISO 8601, json as JSON. `null` and `undefined` are persisted
as-is; an empty string is read back as an empty string without parsing.

## Hydrators

`ModelHydrator` subclasses registered under the `ModelHydrator` DI token. `model.hydrate(data)`
resolves **all** of them and runs each in turn.

| Hydrator | Responsibility |
| --- | --- |
| `DbPropertyHydrator` | Keys matching a declared column. Runs `Converter.fromDB`. |
| `NonDbPropertyHydrator` | Every other key, assigned raw. |
| `OneToManyRelationHydrator` | A `Many` relation arriving as an array — builds a populated `OneToManyRelationList`. |
| `OneToOneRelationHydrator` | A `One` relation arriving as an object or a model — builds a populated `SingleRelation`. |
| `JunctionModelPropertyHydrator` | `@JunctionTable` properties, from `values.JunctionModel`. |

Three behaviours worth knowing:

**A null primary key never overwrites.** `DbPropertyHydrator` skips a key column whose incoming
value is `null` or `undefined`, so a `LEFT JOIN` miss cannot wipe the target's key.

**A model instance on a foreign-key column is translated to its key.** Passing a resolved model
under a FK column name (as `@spinajs/orm-http`'s DTO `@Relation` does) stores the primary key,
not the object.

**Relations hydrate only when the key is present.** Both relation hydrators are guarded by
`values[key] != null`, so a relation the query did not ask for is never marked `Populated`.

`OneToManyRelationHydrator` also deletes the owner's foreign-key property after building the
list, and both relation hydrators call `snapshotRelation`.

### Adding one

```ts sample
import { Injectable } from '@spinajs/di';
import { ModelHydrator, ModelBase } from '@spinajs/orm';

@Injectable(ModelHydrator)
export class AuditTrailHydrator extends ModelHydrator {
  public hydrate(target: ModelBase, values: Record<string, unknown>): void {
    if (values['__audit__']) {
      (target as unknown as { AuditTrail: unknown }).AuditTrail = values['__audit__'];
    }
  }
}
```

## Dehydrators

| Dehydrator | Output |
| --- | --- |
| `StandardModelDehydrator` | Columns only. Backs `dehydrate()` and `toJSON()`. |
| `StandardModelWithRelationsDehydrator` | Columns plus relations, recursed. Backs `dehydrateWithRelations()`. |

`StandardModelDehydrator` skips columns in `options.omit`, and skips a column that is a
relation's foreign key **unless it is also a primary key**. It runs `Converter.toDB`, then
applies `skipNull` / `skipUndefined` / `skipEmptyArray`.

It **throws** `Field X cannot be null` for a non-nullable, non-primary-key column holding
`null`, `undefined` or `''`, unless `ignoreNullable` is set.

`StandardModelWithRelationsDehydrator` emits a `One` relation's dehydrated value when loaded and
falls back to the raw foreign key otherwise; a `Many` relation becomes an array, `[]` when empty.
`omit` is **not** propagated into nested relations — the recursive calls pass `omit: []`.

## Model → SQL

`ModelToSqlConverter.toSql(model)` builds the payload for `INSERT` and `UPDATE`.
`StandardModelToSqlConverter` is registered on every driver's container.

The rules:

1. Serialize every column that is not `Virtual`, **skipping foreign-key columns that an actual
   relation manages** — those are written from the relation instead. A foreign-key column with
   *no* backing relation (a plain owner-id column) is serialized normally; skipping those broke
   inserts against their `NOT NULL` constraints.
2. **Throw** `Field X cannot be null` for a non-nullable, non-primary-key column holding `null`,
   `undefined` or `''`.
3. Run each column's `Converter.toDB`.
4. For each `One` relation holding a target: write the foreign key from the target's **join
   column** (`Relation.PrimaryKey` — its own primary key unless `@BelongsTo` names another
   one). When the `SingleRelation` has no `Value`, fall back to the raw foreign-key column
   hydrated from the row — without that fallback `InsertOrUpdate` emits an empty binding and
   orphans the row. A relation left detached by `attach(null)` writes `NULL`.
5. For a `Recursive` relation, copy the foreign key straight through.

`ObjectToSqlConverter` does the same for a plain object plus a descriptor — it is what
`Model.insert({...})` uses — except that it still writes the target's **primary key**, not the
join column. It skips `undefined` values entirely and handles `One` relations only when the
property holds a `ModelBase`.

### Replacing them

Both are registered on the **driver's** container, so an override is per connection.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, StandardModelToSqlConverter, ModelToSqlConverter, ModelBase } from '@spinajs/orm';

export class TenantStampingConverter extends StandardModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const payload = super.toSql(model) as Record<string, unknown>;
    payload['TenantId'] = 7;
    return payload;
  }
}

export function install() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;
  driver.Container.register(TenantStampingConverter).as(ModelToSqlConverter);
}
```

## Snapshots

`snapshot.ts` provides the diff baseline machinery.

| Export | Purpose |
| --- | --- |
| `createSnapshot()` | An empty `IModelSnapshot` — `{ Columns, Relations }`. |
| `snapshotValue(value, converter?)` | The value to store as the baseline. |
| `snapshotEquals(a, b, converter?)` | Baseline-vs-current comparison. |
| `snapshotFromRow(descriptor, row)` | Build a column baseline from a raw row — used by `save({ reload: true })`. |
| `UNCOPYABLE` | Sentinel for a value that cannot be copied. |

`snapshotValue` delegates to the converter's `snapshotValue` when it has one. When it does not
and the value is a mutable instance the ORM cannot copy, it stores `UNCOPYABLE`, which never
compares equal — so the column reads as always-changed. That is the loud failure mode described
above, and implementing the two hooks is how you replace it with a precise diff.

## `ServerResponseMapper`

Normalizes a driver's raw insert response into `DbServerResponse`
(`{ RowsAffected, LastInsertId, Returning }`).

**Every driver must register an implementation.** The base class throws rather than defining a
default, because the shape of an insert response is dialect-specific:

```
no ServerResponseMapper is registered for this connection. Every driver must register one:
container.register(MyMapper).as(ServerResponseMapper)
```

It is declared as a throwing concrete class rather than an abstract method so a container
missing the registration names the unimplemented contract, instead of dying with
`read is not a function` several frames deep inside a result middleware.

## Model middleware

`ModelMiddleware` is an abstract lifecycle hook with `onInsert`, `onUpdate`, `onDelete` and
`onSelect`, each taking a model and returning a promise. Register subclasses under the
`ModelMiddleware` token.

For query-level interception — which is what most cross-cutting concerns actually need — use
`QueryMiddleware` instead; see [06-query-builder.md](06-query-builder.md).

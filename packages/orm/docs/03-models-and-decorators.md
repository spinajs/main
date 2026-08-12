# Models and decorators

A model is a class extending `ModelBase` carrying `@Model` and `@Connection`. Everything the
ORM knows about it lives in an `IModelDescriptor` stored as *own* metadata on the class under
the `MODEL_DESCTRIPTION_SYMBOL` key.

## The model descriptor

Read it with `Model.getModelDescriptor()` (static, installed by `Orm`) or
`extractModelDescriptor(SomeClass)`.

| Field | Meaning |
| --- | --- |
| `Name` | The class's own name. Never inherited. |
| `TableName` | From `@Model`. |
| `Connection` | From `@Connection`. |
| `PrimaryKey` | `string[]` — key columns in decorator-evaluation order. Empty when no `@Primary`. |
| `PrimaryKeyGeneration` | `Map<column, 'auto' \| 'uuid' \| 'assigned'>`. |
| `Columns` | `IColumnDescriptor[]`. Reflected from the database and merged with decorator declarations. |
| `Converters` | `Map<column, IValueConverterDescriptor>` from the converter decorators. |
| `Relations` | `Map<name, IRelationDescriptor>`. |
| `Timestamps` | `{ CreatedAt, UpdatedAt }` column names, `''` when unset. |
| `SoftDelete` | `{ DeletedAt }` column name. |
| `Archived` | `{ ArchivedAt }` column name. |
| `DiscriminationMap` | `{ Field, Models }`. |
| `JunctionModelProperties` | From `@JunctionTable`. |
| `Driver` | The resolved `OrmDriver`, assigned during `reloadTableInfo()`. |
| `Schema` | JSON schema built from the columns — see [11-converters-and-hydration.md](11-converters-and-hydration.md). |

`PrimaryKey` is an **array**. A single-column key is a one-element array. Code that treats it as
a string will compile a column name of `0` — this is the single most common porting mistake.

## Class-level decorators

### `@Model(tableName)`

Binds the class to a table and registers it under the `__models__` DI key so `Orm` discovers it.

### `@Connection(name)`

Names the connection from `db.Connections` (or an alias, or `default`).

### `@DiscriminationMap(fieldName, entries)`

Creates a different concrete model per value of a column — single-table inheritance.

```ts sample
import { Connection, Model, ModelBase, Primary, DiscriminationMap } from '@spinajs/orm';

@Connection('default')
@Model('animals')
export class Cat extends ModelBase {
  @Primary()
  public Id: number;

  public Kind: string;
}

@Connection('default')
@Model('animals')
export class Dog extends ModelBase {
  @Primary()
  public Id: number;

  public Kind: string;
}

@Connection('default')
@Model('animals')
@DiscriminationMap('Kind', [
  { Key: 'cat', Value: Cat },
  { Key: 'dog', Value: Dog },
])
export class Animal extends ModelBase {
  @Primary()
  public Id: number;

  public Kind: string;
}
```

Selecting `Animal` now yields `Cat` and `Dog` instances according to each row's `Kind`. The
switch happens in `DiscriminationMapMiddleware`, which is registered on the builder by
`createQuery` whenever the descriptor has a `DiscriminationMap.Field`.

### `@Migration(connectionName)`

Marks an `OrmMigration` subclass and registers it under `__migrations__`. Covered in
[10-schema-and-migrations.md](10-schema-and-migrations.md).

## Primary keys

### `@Primary(options?)`

Marks a column as part of the key. Apply it to more than one property to declare a composite
key; the column order is decorator-evaluation order.

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
```

`options.generated` picks the generation strategy:

| Strategy | Behaviour |
| --- | --- |
| `auto` (default) | The database assigns it — identity / auto-increment. Read back after insert via `RETURNING` where supported, otherwise from the reported insert id. |
| `uuid` | Generated client-side at **construction**, so the value is available before the row reaches the database. |
| `assigned` | The caller supplies it. Inserting without one throws before any SQL is built. |

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('uuid_key_model')
export class Document extends ModelBase {
  @Primary({ generated: 'uuid' })
  public Id: string;

  public Name: string;
}

@Connection('default')
@Model('assigned_key_model')
export class CountryCode extends ModelBase {
  @Primary({ generated: 'assigned' })
  public Code: string;

  public Name: string;
}
```

`@Primary()` is **additive across inheritance**. A subclass cannot replace a base class's key,
only extend it — declare `@Primary()` on every key column of the concrete model.

## Column decorators

### `@Uuid()`

Marks a column as a UUID. A fresh value is generated in `setDefaults()` at construction, and
`UuidConverter` stores it as a 16-byte `BINARY` and reads it back as the canonical dashed form.
Pair it with `table.uuid('Col')` in the migration, which is an alias for `binary(name, 16)`.

### `@Ignore()`

Excludes the column from JSON serialization / dehydration. It is still read and written.

### `@Hidden()`

Marks a property the model never hands out. `dehydrate()` and `dehydrateWithRelations()` omit it
unconditionally, and it is stripped from the model's **response** schema
(`descriptor.ResponseSchema`), so generated API documentation never advertises a field the ORM
guarantees is absent.

The **write** contract keeps it: `descriptor.Schema` still lists the property, because hiding a
value on the way out says nothing about whether a client may send it in. Use `@Ignore()` for a
property that is not part of the table at all.

Works on **relation** properties as well as columns.

The list lands on `descriptor.Hidden` at class-definition time, so it is readable without an
`Orm` and without a database — that is how the OpenAPI response schemas are built.

Like `@Primary()` it is **additive across inheritance**: a subclass starts from everything its
ancestors hide and may add to it, without writing back into their descriptors. Re-declaring a
property the parent already hides is harmless — it is recorded once.

```ts sample
import { Connection, Model, ModelBase, Primary, Hidden, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('accounts')
export class Account extends ModelBase<Account> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('members')
export class Member extends ModelBase<Member> {
  @Primary()
  @Hidden()
  public Id: number;

  public Uuid: string;

  /** Never leaves the process. */
  @Hidden()
  public Password: string;

  @Hidden()
  @BelongsTo(Account, 'account_id')
  public Account: SingleRelation<Account>;
}

export async function hiding() {
  const member = await Member.getOrFail(1);

  // { Uuid: '...' } — no Id, no Password, no Account
  return member.dehydrateWithRelations();
}
```

### `@JunctionTable()`

Names a property that carries the junction row of a many-to-many relation, so the extra columns
on the join table are hydrated too. The property's type is read via `design:type` metadata.

## Timestamp and lifecycle decorators

All four require the property to be typed `DateTime` (luxon) — they throw at decoration time
otherwise — and each attaches `DatetimeValueConverter` to the column.

| Decorator | Effect |
| --- | --- |
| `@CreatedAt()` | Set to `DateTime.now()` in the constructor. Enables `Model.newest()` / `Model.oldest()`. |
| `@UpdatedAt()` | Stamped by `instance.update()` whenever something is actually written. |
| `@SoftDelete()` | `destroy()` stamps the column instead of deleting; selects filter the row out unless you call `.withDeleted()`. |
| `@Archived()` | `archive()` stamps the column. |

```ts sample
import { Connection, Model, ModelBase, Primary, CreatedAt, UpdatedAt, SoftDelete } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @UpdatedAt()
  public UpdatedAt: DateTime;

  @SoftDelete()
  public DeletedAt: DateTime;
}

export async function softDelete() {
  const article = await Article.getOrFail(1);

  // UPDATE articles SET DeletedAt = now() WHERE Id = 1
  await article.destroy();

  const visible = await Article.select();               // excludes the row
  const everything = await Article.select().withDeleted(); // includes it

  return { visible, everything };
}
```

## Type / converter decorators

| Decorator | Converter | Notes |
| --- | --- | --- |
| `@DateTime()` | `DatetimeValueConverter` | Property must be luxon `DateTime`. Throws if the column already has a converter. |
| `@Json()` | `JsonValueConverter` | For a **string** column holding JSON. Do *not* use it for a native JSON column — those are detected automatically from the reflected type. |
| `@Set()` | `SetValueConverter` | Property must be an `Array`. Emulates MySQL `SET`. Throws if a converter is already attached. |
| `@UniversalConverter(typeColumn?)` | `UniversalValueConverter` | For "type column" tables: a text column whose runtime type is decided by a sibling column, `Type` by default. |

```ts sample
import { Connection, Model, ModelBase, Primary, Json, Set as SetColumn, UniversalConverter } from '@spinajs/orm';

@Connection('default')
@Model('user_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Payload: { theme: string; density: number };

  @SetColumn()
  public Flags: string[];

  /** Runtime type of `Value` is read from the `Type` column. */
  public Type: string;

  @UniversalConverter('Type')
  public Value: unknown;
}
```

## Inheritance

Descriptors are collapsed down the prototype chain by `@spinajs/di`'s
`getInheritedDescriptor`, so a subclass inherits its base's columns, relations and options.

Two rules follow from how that merge works, and both matter in practice:

**`Name` is never inherited.** It is reassigned to the class's own name on every descriptor
access, because the merger would otherwise keep the parent's non-empty name over the child's
default `''`.

**Inherited members are detached before the first decorator mutates them.** The merger rebuilds
`Columns` and `Relations` one level deep, but their *elements* stay shared by reference with the
parent. Decorators like `@Ignore`, `@Uuid` and `@Recursive` mutate a found element in place,
which on an inherited member would write straight through to the base model's descriptor. The
first decorator to touch a class therefore runs `detachInheritedModelMembers`, giving it its own
shallow copies of `Columns`, `Relations`, `Timestamps`, `SoftDelete`, `Archived` and
`DiscriminationMap`.

Relations are copied with `Object.getOwnPropertyDescriptors` rather than a spread, deliberately:
a relation descriptor may carry a lazily-defined `PrimaryKey` **accessor** (from `@BelongsTo` or
`@HasManyToMany` given a model *name*), and spreading would invoke that getter at decoration
time — when the `Orm` service does not exist yet — freezing the result into a plain value.

```ts sample
import { Connection, Model, ModelBase, Primary, Ignore } from '@spinajs/orm';

export abstract class AuditedBase extends ModelBase {
  @Primary()
  public Id: number;

  public CreatedBy: string;
}

@Connection('default')
@Model('invoices')
export class Invoice extends AuditedBase {
  public Total: number;

  // Marks Invoice's own copy of the column — AuditedBase is untouched.
  @Ignore()
  public InternalNote: string;
}
```

## Writing the descriptor by hand

`updateModelDescriptor` is the supported way to mutate a descriptor outside a decorator. It
routes through `getInheritedDescriptor`, so the write lands on the class's own descriptor and
cannot leak into its base.

```ts sample
import { Connection, Model, ModelBase, Primary, updateModelDescriptor } from '@spinajs/orm';

@Connection('default')
@Model('widgets')
export class Widget extends ModelBase {
  @Primary()
  public Id: number;

  public Label: string;
}

updateModelDescriptor(Widget, (descriptor) => {
  descriptor.Columns.push({
    Name: 'ComputedLabel',
    Type: 'string',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: '',
    Unsigned: false,
    Nullable: true,
    PrimaryKey: false,
    AutoIncrement: false,
    Converter: null,
    Schema: null,
    Unique: false,
    Uuid: false,
    Ignore: false,
    Aggregate: false,
    Virtual: true,
    IsForeignKey: false,
    ForeignKeyDescription: null,
  });
});
```

`_prepareColumnDesc` fills the same defaults for you when you only care about a couple of
fields.

## Column descriptor reference

Every column carries an `IColumnDescriptor`. Most fields are reflected from the database by
`driver.tableInfo()`; a few are set by decorators.

| Field | Source | Meaning |
| --- | --- | --- |
| `Name` | both | Column name. |
| `Type` | reflected | Normalized type (`int`, `string`, `dateTime`, …). |
| `NativeType` | reflected | Full database type, e.g. `int(10) unsigned`. Empty for a column the database has not been asked about. |
| `MaxLength`, `Unsigned`, `Nullable`, `DefaultValue`, `Comment` | reflected | As declared in the database. |
| `PrimaryKey`, `AutoIncrement`, `Unique` | reflected | Constraint flags. |
| `Converter` | resolved | Value converter instance, from a decorator or the type map. |
| `Uuid` | `@Uuid` | Generate a UUID at construction. |
| `Ignore` | `@Ignore` | Skip during serialization. |
| `Virtual` | decorator | Not a real database column; excluded from `SELECT` column lists. |
| `Aggregate` | decorator | Produced by an aggregate expression. |
| `IsForeignKey` / `ForeignKeyDescription` | reflected + relations | Marked for any column named by a relation's `ForeignKey`. |
| `Schema` | built | JSON-schema fragment for this column. |

`Nullable` deserves a warning: `_prepareColumnDesc` defaults it to `false`, so a model whose
table info has not been loaded reports *every* column as non-nullable. Code that reasons about
nullability must check `NativeType` is non-empty first — which is exactly what
`resolveOrphanPolicy` does.

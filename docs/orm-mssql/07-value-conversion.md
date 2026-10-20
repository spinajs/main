# Value conversion

`MsSqlOrmDriver` registers `IsoDatetimeValueConverter` from `@spinajs/orm-sql` (see [Migration](#migration)), so model datetime columns and `Date` / luxon `DateTime` values in queries and raw statements are written as ISO 8601 in UTC (`2024-05-01T08:30:00.000Z`) and read back as a `DateTime` in UTC. It also registers `MssqlModelDehydrator`, which the ORM never resolves.

## How it works

### Writing a datetime

1. A model column decorated `@DateTime()`, `@CreatedAt()`, `@UpdatedAt()`, `@SoftDelete()` or `@Archived()` names `DatetimeValueConverter` as its converter. A `Date` or `DateTime` passed to a builder (`where('PaidAt', '>', since)`) is mapped to the same token by the `Orm`.
2. The token is resolved from the connection's container, which returns `IsoDatetimeValueConverter`.
3. `toDB(value)` returns:

| Value | Written as |
| --- | --- |
| `Date` | the instant in UTC with `Z`, eg. `2024-05-01T08:30:00.000Z` |
| luxon `DateTime` in any zone | the same instant in UTC with `Z` |
| ISO 8601 or SQL-format `string` | parsed (no offset = UTC) and written in UTC with `Z` |
| a `string` that is not a datetime | throws `InvalidArgument` naming the column |
| any of the above, for a column whose type is numeric (`int`, `bigint`, `decimal`, ...) | Unix seconds |
| `null`, `undefined`, `''` | `null` |

`model.dehydrate()` and `toJSON()` call the same converter with dehydrate options: they write `dateTimeFormat` (`'iso'`, `'sql'` or `'unix'`), ISO 8601 in UTC when none is set.

4. The string is bound as a parameter; see [Executing statements](02-executing-statements.md).

### Reading a datetime

1. `mssql` returns `DATE`, `DATETIME`, `DATETIME2` and `DATETIMEOFFSET` columns as JavaScript `Date`.
2. `fromDB(value)` returns `null` for an empty value, otherwise the instant as a `DateTime` in UTC.
3. The driver connects with `useUTC: true`, so `DATETIME`/`DATETIME2` values are read as UTC and `DATETIMEOFFSET` values exactly.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Datetime conversion | `DatetimeValueConverter` (from `@spinajs/orm`), in the driver's child container | `IsoDatetimeValueConverter` (exported by `@spinajs/orm-sql`) | `SqlDatetimeValueConverter` | Extend `DatetimeValueConverter`, implement `toDB()` and `fromDB()`, register `.as(DatetimeValueConverter)` in a driver subclass after `super.resolve()`. |
| Model dehydration | `ModelDehydrator` | `MssqlModelDehydrator` (not exported) | | Has no effect: the core resolves `StandardModelDehydrator` by class. To change `model.dehydrate()` on a connection, register a subclass `.as(StandardModelDehydrator)`. |
| Per-column converters | `@Converter(...)` on a model property | | `JsonValueConverter`, `UuidConverter`, `UniversalValueConverter` (registered by `OrmDriver`) | See [Converters and hydration](../orm/04-converters-and-hydration.md). |

### Model dehydration: custom implementation

`model.dehydrate()` resolves `StandardModelDehydrator` from the model's container, which is the connection's container. Register a subclass under that class to change the payload for models on one connection, for example to leave out the key of a model that is not saved yet:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { IDehydrateOptions, ModelBase, StandardModelDehydrator } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

export class UnsavedKeyDehydrator extends StandardModelDehydrator {
  public dehydrate(model: ModelBase, options?: IDehydrateOptions) {
    const data: Record<string, unknown> = super.dehydrate(model, options);
    const key = model.ModelDescriptor!.Columns.find((c) => c.PrimaryKey);

    if (key && !data[key.Name]) {
      delete data[key.Name];
    }

    return data;
  }
}

@Injectable('orm-driver-mssql-api')
@NewInstance()
export class ApiMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UnsavedKeyDehydrator).as(StandardModelDehydrator);
  }
}
```

## Important behaviour

- **A datetime string is parsed, not passed through.** `Model.update({ CreatedAt: '2024-05-01 08:30:00' })`, a model property and `whereIn('CreatedAt', [...])` on a model column go through `toDB()`, so an ISO 8601 or SQL-format string is written in the converter's format and any other string throws `InvalidArgument`. A string passed straight to a builder without a model column (`values({ CreatedAt: '2024-05-01' })`) is not converted and reaches the server as is.
- **`MssqlModelDehydrator` is never used.** The ORM resolves `StandardModelDehydrator` by class, so the `ModelDehydrator` registration has no effect on `dehydrate()` or inserts.
- **Boolean columns** use the shared `SqlBooleanValueConverter`; `mssql` binds JavaScript booleans as `BIT`.

## Best practices

- Create datetime columns with the schema builder: `dateTime()` and `timestamp()` are `DATETIMEOFFSET(3)`, which keeps the instant whatever offset stamped it. A hand-written `DATETIME` or `DATETIME2` column holds no offset and is read as UTC.

## Migration

`DatetimeValueConverter` on MSSQL is `IsoDatetimeValueConverter`. The internal `MsSqlDatetimeValueConverter` is removed; it was never exported, so no import changes. What changes is the stored text and the zone of values read back:

| | `MsSqlDatetimeValueConverter` | `IsoDatetimeValueConverter` |
| --- | --- | --- |
| luxon `DateTime` written | its own zone's wall clock, no offset: `2024-05-01T10:30:00.000` for 10:30 in `Europe/Warsaw` | the instant in UTC: `2024-05-01T08:30:00.000Z` |
| string written | parsed, wall clock without offset | parsed (no offset = UTC), written in UTC with `Z` |
| value read | `DateTime` in the process's local zone | `DateTime` in UTC |
| new `dateTime()` / `timestamp()` column | <!-- TODO(docs-hook): verify the column type dateTime()/timestamp() created before DATETIMEOFFSET(3) --> | `DATETIMEOFFSET(3)` |

Rows written from a non-UTC `DateTime` hold local wall-clock values, which the driver reads as UTC. Convert them once, and convert existing columns to `DATETIMEOFFSET(3)` so new values keep their offset:

```ts
// Before: the application formats in its own zone, the column holds that wall clock
const paidAt = DateTime.now().setZone('Europe/Warsaw');
await Order.update({ PaidAt: paidAt }).where('Id', id); // stored '2024-05-01T10:30:00.000'

// After: the same call stores the instant in UTC; display in the user's zone on read
await Order.update({ PaidAt: paidAt }).where('Id', id); // stored '2024-05-01T08:30:00.000Z'
const order = await Order.where('Id', id).first();
const shown = order!.PaidAt.setZone('Europe/Warsaw');
```

```ts
import { Migration, OrmDriver, OrmMigration, RawQuery } from '@spinajs/orm';

/** Rewrites Warsaw wall-clock datetimes as UTC instants in a DATETIMEOFFSET(3) column. */
@Migration('mssql')
export class OrdersPaidAtUtc_2024_06_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw(RawQuery.create("UPDATE [orders] SET [PaidAt] = CAST([PaidAt] AS DATETIME2(3)) AT TIME ZONE 'Central European Standard Time' AT TIME ZONE 'UTC'"));
    await connection.schema().raw(RawQuery.create('ALTER TABLE [orders] ALTER COLUMN [PaidAt] DATETIMEOFFSET(3)'));
  }

  public async down(): Promise<void> {}
}
```

<!-- TODO(docs-hook): verify that connection.schema().raw(RawQuery) is the migration API for raw DDL -->

## Examples

### Find orders paid in the last 24 hours

```ts sample
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('mssql')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @DateTimeColumn()
  public PaidAt: DateTime;
}

export async function paidToday() {
  // the DateTime is converted by the connection's DatetimeValueConverter
  return await Order.where('PaidAt', '>=', DateTime.utc().minus({ hours: 24 })).orderBy('PaidAt');
}
```

## Related

- [Converters and hydration](../orm/04-converters-and-hydration.md): how converters are attached to columns and run.
- [Value converters and default values](../orm-sql/05-value-converters-and-defaults.md): the shared converters `SqlDriver` registers.
- [Extending the driver](08-extending-the-driver.md): registration rules for every token.

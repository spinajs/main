# Value conversion

`MsSqlOrmDriver` registers `IsoDatetimeValueConverter` from `@spinajs/orm-sql`, so model datetime columns and `Date` / luxon `DateTime` values in queries and raw statements are written as ISO 8601 in UTC (`2024-05-01T08:30:00.000Z`) and read back as a `DateTime` in UTC.

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
| Datetime conversion | `DatetimeValueConverter` (from `@spinajs/orm`), in the driver's child container | `IsoDatetimeValueConverter` (exported by `@spinajs/orm-sql`) | `SqlDatetimeValueConverter` (registered by `SqlDriver`, replaced here) | Extend `DatetimeValueConverter`, implement `toDB()` and `fromDB()`, register `.as(DatetimeValueConverter)` in a driver subclass after `super.resolve()`. |
| Model dehydration | `StandardModelDehydrator` (from `@spinajs/orm`), resolved by class | the shared `StandardModelDehydrator` | | To change `model.dehydrate()` on a connection, register a subclass `.as(StandardModelDehydrator)`. |
| Per-column converters | `@Converter(...)` on a model property | | `JsonValueConverter`, `UuidConverter`, `UniversalValueConverter` (registered by `OrmDriver`) | See [Converters and hydration](../orm/04-converters-and-hydration.md). |

### Datetime conversion: custom implementation

Write datetimes as the UTC wall clock without an offset, `2024-05-01 08:30:00.000`, for example into `DATETIME2` columns that another application reads as text. `SqlDatetimeValueConverter` writes that format and reads values back in UTC; register it in place of the ISO converter:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DatetimeValueConverter } from '@spinajs/orm';
import { SqlDatetimeValueConverter } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@Injectable('orm-driver-mssql-wallclock')
@NewInstance()
export class WallClockMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlDatetimeValueConverter).as(DatetimeValueConverter);
  }
}
```

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

- **`Date` and `DateTime` are both written in UTC.** The same instant stored from either gives the same column value.
- **A datetime string is parsed, not passed through.** `Model.update({ CreatedAt: '2024-05-01 08:30:00' })`, a model property and `whereIn('CreatedAt', [...])` on a model column go through `toDB()`, so an ISO 8601 or SQL-format string is written in the converter's format and any other string throws `InvalidArgument`. A string passed straight to a builder without a model column (`values({ CreatedAt: '2024-05-01' })`) is not converted and reaches the server as is.
- **Boolean columns** use the shared `SqlBooleanValueConverter`; `mssql` binds JavaScript booleans as `BIT`.

## Best practices

- Create datetime columns with the schema builder: `dateTime()` and `timestamp()` are `DATETIMEOFFSET(3)`, which keeps the instant whatever offset stamped it. A hand-written `DATETIME` or `DATETIME2` column holds no offset and is read as UTC.

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

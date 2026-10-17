# Value conversion

`MsSqlOrmDriver` registers `MsSqlDatetimeValueConverter` in place of the shared datetime converter, so model datetime columns and `Date` / luxon `DateTime` values in queries are written as ISO strings and read back as `DateTime`. It also registers `MssqlModelDehydrator`, which the ORM never resolves.

## How it works

### Writing a datetime

1. A model column decorated `@DateTime()`, `@CreatedAt()`, `@UpdatedAt()`, `@SoftDelete()` or `@Archived()` names `DatetimeValueConverter` as its converter. A `Date` or `DateTime` passed to a builder (`where('PaidAt', '>', since)`) is mapped to the same token by the `Orm`.
2. The token is resolved from the connection's container, which returns `MsSqlDatetimeValueConverter`.
3. `toDB(value)` returns:

| Value | Written as |
| --- | --- |
| `Date` | `value.toISOString()`: UTC with a `Z` suffix, eg. `2024-05-01T08:30:00.000Z` |
| luxon `DateTime` | `value.toISO({ includeOffset: false })`: the wall-clock time **in the `DateTime`'s own zone**, no offset |
| anything else (`string`, `number`, `null`) | `null` |

4. The string is bound as a parameter; see [Executing statements](02-executing-statements.md).

### Reading a datetime

1. `mssql` returns `DATE`, `DATETIME` and `DATETIME2` columns as JavaScript `Date`.
2. `fromDB(value)` returns `null` for an empty value, otherwise `DateTime.fromJSDate(value)`, in the process's local zone.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Datetime conversion | `DatetimeValueConverter` (from `@spinajs/orm`), in the driver's child container | `MsSqlDatetimeValueConverter` (not exported) | `SqlDatetimeValueConverter` (registered by `SqlDriver`, replaced here) | Extend `DatetimeValueConverter`, implement `toDB()` and `fromDB()`, register `.as(DatetimeValueConverter)` in a driver subclass after `super.resolve()`. |
| Model dehydration | `ModelDehydrator` | `MssqlModelDehydrator` (not exported) | | Has no effect: the core resolves `StandardModelDehydrator` by class. To change `model.dehydrate()` on a connection, register a subclass `.as(StandardModelDehydrator)`. |
| Per-column converters | `@Converter(...)` on a model property | | `JsonValueConverter`, `UuidConverter`, `UniversalValueConverter` (registered by `OrmDriver`) | See [Converters and hydration](../orm/04-converters-and-hydration.md). |

### Datetime conversion: custom implementation

Store every datetime as UTC, whatever the zone of the `DateTime`, and read it back in UTC:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DatetimeValueConverter } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { DateTime } from 'luxon';

export class UtcDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: unknown) {
    if (value instanceof Date) {
      return DateTime.fromJSDate(value).toUTC().toISO({ includeOffset: false });
    }

    if (value instanceof DateTime) {
      return value.toUTC().toISO({ includeOffset: false });
    }

    // keeps already formatted values such as '2024-05-01' instead of writing NULL
    return typeof value === 'string' ? value : null;
  }

  public fromDB(value: unknown) {
    return value instanceof Date ? DateTime.fromJSDate(value, { zone: 'utc' }) : null;
  }
}

@Injectable('orm-driver-mssql-utc')
@NewInstance()
export class UtcMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UtcDatetimeValueConverter).as(DatetimeValueConverter);
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

- **`Date` and `DateTime` are written differently.** A `Date` is written in UTC; a `DateTime` is written as its local wall-clock time without an offset. The same instant stored once from each differs by the zone offset unless the `DateTime` is in UTC.
- **A string assigned to a datetime model property is written as `NULL`.** Convert it to a `DateTime` first, or a `NOT NULL` column fails. A string passed straight to a builder (`values({ CreatedAt: '2024-05-01' })`) is not converted and reaches the server as is.
- **Reads come back in the local zone** of the Node process.
- **`MssqlModelDehydrator` is never used.** The ORM resolves `StandardModelDehydrator` by class, so the `ModelDehydrator` registration has no effect on `dehydrate()` or inserts.
- **Boolean columns** use the shared `SqlBooleanValueConverter`; `mssql` binds JavaScript booleans as `BIT`.

## Best practices

- Keep all datetimes in UTC: use `DateTime.utc()` or register `UtcDatetimeValueConverter`.
- Use `DATETIME2` columns (see the column compiler in [Schema dialect](06-schema-dialect.md#column-definition-custom-implementation)) for sub-millisecond precision; `DATETIME` rounds to 1/300 s.

## Patterns and antipatterns

```ts
// Don't: a local-zone DateTime is stored as local wall-clock time, a Date as UTC
order.PaidAt = DateTime.now();

// Do
order.PaidAt = DateTime.utc();
```

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

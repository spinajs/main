# Value conversion

`MsSqlOrmDriver` registers `MsSqlDatetimeValueConverter` in place of the shared datetime converter, so model datetime columns and `Date` / luxon `DateTime` values in queries are written as UTC ISO strings and read back as `DateTime`.

## How it works

### Writing a datetime

1. A model column decorated `@DateTime()`, `@CreatedAt()`, `@UpdatedAt()`, `@SoftDelete()` or `@Archived()` names `DatetimeValueConverter` as its converter. A `Date` or `DateTime` passed to a builder (`where('PaidAt', '>', since)`) is mapped to the same token by the `Orm`.
2. The token is resolved from the connection's container, which returns `MsSqlDatetimeValueConverter`.
3. `toDB(value)` returns:

| Value | Written as |
| --- | --- |
| `Date` | `value.toISOString()`: UTC with a `Z` suffix, eg. `2024-05-01T08:30:00.000Z` |
| luxon `DateTime` | `value.toUTC().toISO({ includeOffset: false })`: UTC, no offset, eg. `2024-05-01T08:30:00.000` |
| `string` | the string unchanged, for SQL Server to parse |
| anything else (`number`, `null`) | `null` |

4. The string is bound as a parameter; see [Executing statements](02-executing-statements.md).

### Reading a datetime

1. `mssql` returns `DATE`, `DATETIME` and `DATETIME2` columns as JavaScript `Date`.
2. `mssql` reads a `DATETIME` value as UTC. `fromDB(value)` returns `null` for an empty value, otherwise `DateTime.fromJSDate(value)`, in the process's local zone.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Datetime conversion | `DatetimeValueConverter` (from `@spinajs/orm`), in the driver's child container | `MsSqlDatetimeValueConverter` (not exported) | `SqlDatetimeValueConverter` (registered by `SqlDriver`, replaced here) | Extend `DatetimeValueConverter`, implement `toDB()` and `fromDB()`, register `.as(DatetimeValueConverter)` in a driver subclass after `super.resolve()`. |
| Model dehydration | `StandardModelDehydrator` (from `@spinajs/orm`), resolved by class | the shared `StandardModelDehydrator` | | To change `model.dehydrate()` on a connection, register a subclass `.as(StandardModelDehydrator)`. |
| Per-column converters | `@Converter(...)` on a model property | | `JsonValueConverter`, `UuidConverter`, `UniversalValueConverter` (registered by `OrmDriver`) | See [Converters and hydration](../orm/04-converters-and-hydration.md). |

### Datetime conversion: custom implementation

Write datetimes without the `Z` suffix, and read them back in UTC instead of the local zone:

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

    // already formatted values such as '2024-05-01' go through unchanged
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

- **`Date` and `DateTime` are both written in UTC.** The same instant stored from either gives the same column value.
- **A string is written as is.** SQL Server parses it; a string with an offset is not converted to UTC.
- **Reads come back in the local zone** of the Node process.
- **Boolean columns** use the shared `SqlBooleanValueConverter`; `mssql` binds JavaScript booleans as `BIT`.

## Best practices

- Assign `Date` or `DateTime` values to datetime properties rather than strings, so the UTC conversion applies.
- Use `DATETIME2` columns (see the column compiler in [Schema dialect](06-schema-dialect.md#column-definition-custom-implementation)) for sub-millisecond precision; `DATETIME` rounds to 1/300 s.

## Patterns and antipatterns

```ts
// Don't: a string with an offset is stored as written, not converted to UTC
order.PaidAt = '2024-05-01T10:30:00+02:00' as any;

// Do
order.PaidAt = DateTime.fromISO('2024-05-01T10:30:00+02:00');
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

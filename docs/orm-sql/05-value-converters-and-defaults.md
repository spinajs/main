# Value converters and default values

`SqlDriver` binds four value converters that translate between JavaScript values and SQL column values: datetimes, `TIME` durations, booleans and `SET` lists. This package also ships `SqlDefaultValueBuilder`, the MySQL spelling of column defaults in `CREATE TABLE`. Replace any of them per connection when your engine stores values differently.

## How it works

1. **Registration.** `SqlDriver.resolve()` registers `SqlDatetimeValueConverter` as `DatetimeValueConverter`, `SqlTimeValueConverter` as `TimeValueConverter`, `SqlBooleanValueConverter` as `BooleanValueConverter` and `SqlSetConverter` as `SetValueConverter` in the driver's container.
2. **Column binding.** Model decorators (`@DateTime()`, `@Bool()`, `@Set()`) attach the token to the column descriptor. `Orm` also maps value constructor names (`Date`, `DateTime`, `Boolean`, `TimeSpan`, ...) to the tokens in `__orm_db_value_converters__`. The core resolves the token from the model's connection container. See [Converters and hydration](../orm/04-converters-and-hydration.md).
3. **Writes.** `toDB(value, model, column, options)` runs for INSERT and UPDATE payloads. Where values convert the same way, through the column's converter or, without one, the converter registered for the value's constructor name in `__orm_db_value_converters__`.
4. **Reads.** `fromDB(value)` runs during hydration.
5. **Serialization.** `dehydrate()` (and so `toJSON()`) calls `toDB()` with a fifth argument, the dehydrate options. The boolean and datetime converters answer differently for it.
6. **Defaults.** `ColumnQueryBuilder.default()` resolves `DefaultValueBuilder` from the connection container with the column builder; `SqlColumnQueryCompiler` renders what it holds.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `IDehydrateOptions.dateTimeFormat` | `string` | unset | `'iso'`, `'sql'`, `'unix'` | Output format of `SqlDatetimeValueConverter` when a model is dehydrated. Passed to `dehydrate()`, not set in config. |

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| `DatetimeValueConverter` | luxon `DateTime` / `Date` and SQL datetime | `SqlDatetimeValueConverter`; MSSQL `MsSqlDatetimeValueConverter` | Extend `DatetimeValueConverter` from `@spinajs/orm`, register in a driver subclass |
| `TimeValueConverter` | `TimeSpan` and SQL `TIME` | `SqlTimeValueConverter` | Extend `TimeValueConverter` |
| `BooleanValueConverter` | `boolean` and `0` / `1` | `SqlBooleanValueConverter` | Extend `BooleanValueConverter` |
| `SetValueConverter` | `string[]` and a comma-joined string | `SqlSetConverter` | Extend `SetValueConverter` |
| `DefaultValueBuilder<T>` | Column default in DDL: `date()`, `dateTime()`, `value(v)`, `raw(query)` | `SqlDefaultValueBuilder` (MySQL); `SqlLiteDefaultValueBuilder` (SQLite), `PostgresDefaultValueBuilder` | Subclass `SqlDefaultValueBuilder`, register `.as(DefaultValueBuilder)` |

The four `Sql*` converter classes are **not exported** from `@spinajs/orm-sql`. To change one, extend the token class from `@spinajs/orm` and implement both methods.

### `SqlDatetimeValueConverter`

| Call | Result |
| --- | --- |
| `toDB(null | undefined)` | `null`, not the epoch |
| `toDB(string)` | parsed with `DateTime.fromISO()` |
| `toDB(Date | DateTime)` with `dateTimeFormat` | `toISO()`, `toSQL({ includeOffset: false })` or `toUnixInteger()` |
| `toDB(...)` for a numeric column (`int`, `integer`, `float`, `double`, `decimal`, `bigint`, `smallint`, `tinyint`, `mediumint`) | Unix seconds |
| `toDB(...)` otherwise | `toSQL({ includeOffset: false })`, eg. `2026-10-17 09:30:00.000` |
| `fromDB(falsy)` | `null` |
| `fromDB(DateTime | Date)` | a `DateTime` |
| `fromDB(integer)` | `DateTime.fromSeconds()` |
| `fromDB(string)` | `DateTime.fromSQL()` |

### `SqlTimeValueConverter`

- `toDB(TimeSpan | string | number)` writes `[-]HH:MM:SS`, with hours above 24 allowed (MySQL `TIME` spans `-838:59:59` to `838:59:59`). A value `TimeSpan.parse()` cannot read becomes `null`.
- `fromDB('[-]H{1,3}:MM:SS[.ffffff]')` returns a `TimeSpan`; other strings fall back to `TimeSpan.parse()`.
- `snapshotValue()` and `snapshotEquals()` compare by total milliseconds, so a `time` column is only reported as changed when its value changed.

### `SqlBooleanValueConverter`

- `toDB(value, model, column, options)` (4 arguments: a write or a where binding) returns `1` / `0`.
- `toDB(value, model, column, options, dehydrateOptions)` (5 arguments, even when the fifth is `undefined`: `dehydrate()`) returns `true` / `false`, matching the `{ type: 'boolean' }` the JSON schema publishes.
- `fromDB()` is `true` for `1`, `true` and `'1'`.

### `SqlSetConverter`

- `toDB(array)` joins with `,`; anything else passes through.
- `fromDB(string)` splits on `,`; a non-string returns `value ?? [value]`.

### `SqlDefaultValueBuilder`

| Method | Stored | Rendered by `SqlColumnQueryCompiler` |
| --- | --- | --- |
| `date()` | `Query = RawQuery('(CURRENT_DATE())')` | `DEFAULT (CURRENT_DATE())` |
| `dateTime()` | `Query = RawQuery('CURRENT_TIMESTAMP')` | `DEFAULT CURRENT_TIMESTAMP` |
| `value('x')`, `value(5)` | `Value` | `DEFAULT 'x'` (escaped, trimmed), `DEFAULT 5` |
| `raw(query)` | `Query` | `DEFAULT <query>` |

Each method returns the column builder, so the chain continues.

## Important behaviour

- `SqlDriver` registers the converters for every SQL connection; a dialect that stores datetimes differently (MSSQL) registers its own after `super.resolve()`.
- `SqlBooleanValueConverter` decides by argument count, not by value: a caller that passes a fifth argument gets a boolean.
- `SqlDatetimeValueConverter` writes local time without an offset. Values are not converted to UTC.
- `SqlLiteralQuoter.quoteDate()` uses the connection's `DatetimeValueConverter`, so a replaced converter also changes dates inlined into view and event bodies.
- `SqlDriver` does not register `DefaultValueBuilder`. MSSQL registers none; `default()` on an MSSQL connection gets no dialect implementation. <!-- TODO(docs-hook): verify what ColumnQueryBuilder.default() resolves on an MSSQL connection -->

## Best practices

- Keep `toDB(null)` returning `null` in your converter; the shipped converters rely on it for nullable columns.
- Implement `snapshotValue()` and `snapshotEquals()` when `fromDB()` returns a mutable object the ORM does not own, as `SqlTimeValueConverter` does.
- Register converter overrides in a driver subclass, not in the root container, so other connections keep theirs.

## Patterns and antipatterns

```ts
// Don't: SqlDatetimeValueConverter is not exported; this import fails
import { SqlDatetimeValueConverter } from '@spinajs/orm-sql';

// Do: extend the token from @spinajs/orm
import { DatetimeValueConverter } from '@spinajs/orm';
export class UtcDatetimeConverter extends DatetimeValueConverter { /* toDB, fromDB */ }
```

```ts
// Don't: returning a boolean for every call writes `true` into an integer column on MySQL
public toDB(value: unknown) {
  return !!value;
}

// Do: keep the write path numeric
public toDB(value: unknown) {
  return value ? 1 : 0;
}
```

## Examples

### Store datetimes as UTC on one connection

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DatetimeValueConverter, IColumnDescriptor, ModelBase } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DateTime } from 'luxon';

export class UtcDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime | null | undefined, _model: ModelBase<unknown>, _column: IColumnDescriptor): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const dt = value instanceof Date ? DateTime.fromJSDate(value) : value;
    return dt.toUTC().toSQL({ includeOffset: false });
  }

  public fromDB(value: string | null): DateTime | null {
    return value ? DateTime.fromSQL(value, { zone: 'utc' }) : null;
  }
}

@Injectable('orm-driver-sqlite-utc')
@NewInstance()
export class UtcSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UtcDatetimeValueConverter).as(DatetimeValueConverter);
  }
}
```

### Default a column to the current timestamp

```ts sample
import { OrmDriver } from '@spinajs/orm';

export async function createAuditTable(driver: OrmDriver): Promise<void> {
  await driver.schema().createTable('audit_log', (table) => {
    table.increments('Id');
    table.string('Action', 64).notNull();
    table.dateTime('CreatedAt').notNull().default().dateTime();
  });
}
```

## Related

- [Converters and hydration](../orm/04-converters-and-hydration.md): how the core picks and calls converters.
- [Schema builder](../orm/09-schema-builder.md): `default()` and the column types.
- [Identifier and literal quoting](04-identifier-and-literal-quoting.md): `quoteDate()` and the datetime converter.
- [`SqlDriver`](01-sql-driver.md): where these are registered.

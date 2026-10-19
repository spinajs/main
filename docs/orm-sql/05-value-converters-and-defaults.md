# Value converters and default values

`SqlDriver` binds four value converters that translate between JavaScript values and SQL column values: datetimes, `TIME` durations, booleans and `SET` lists. This package also ships `SqlDefaultValueBuilder`, the MySQL spelling of column defaults in `CREATE TABLE`. Replace any of them per connection when your engine stores values differently.

## How it works

1. **Registration.** `SqlDriver.resolve()` registers `SqlDatetimeValueConverter` (MySQL text) as `DatetimeValueConverter`, `SqlTimeValueConverter` as `TimeValueConverter`, `SqlBooleanValueConverter` as `BooleanValueConverter` and `SqlSetConverter` as `SetValueConverter` in the driver's container. PostgreSQL, SQLite and MSSQL replace it with `IsoDatetimeValueConverter`.
2. **Column binding.** Model decorators (`@DateTime()`, `@Bool()`, `@Set()`) attach the token to the column descriptor. `Orm` also maps value constructor names (`Date`, `DateTime`, `Boolean`, `TimeSpan`, ...) to the tokens in `__orm_db_value_converters__`. The core resolves the token from the model's connection container. See [Converters and hydration](../orm/04-converters-and-hydration.md).
3. **Writes.** `toDB(value, model, column, options)` runs for INSERT and UPDATE payloads. Where values convert the same way, through the column's converter or, without one, the converter registered for the value's constructor name in `__orm_db_value_converters__`.
4. **Reads.** `fromDB(value)` runs during hydration.
5. **Serialization.** `dehydrate()` (and so `toJSON()`) calls `toDB()` with a fifth argument, the dehydrate options. The boolean and datetime converters answer differently for it.
6. **Defaults.** `ColumnQueryBuilder.default()` resolves `DefaultValueBuilder` from the connection container with the column builder; `SqlColumnQueryCompiler` renders what it holds.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `IDehydrateOptions.dateTimeFormat` | `string` | unset | `'iso'`, `'sql'`, `'unix'` | Output format of the datetime converters when a model is dehydrated; unset means `iso`. Passed to `dehydrate()`, not set in config. |

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| `DatetimeValueConverter` | luxon `DateTime` / `Date` and SQL datetime | `SqlDatetimeValueConverter`, `IsoDatetimeValueConverter` | Extend `DatetimeValueConverter` from `@spinajs/orm`, register in a driver subclass |
| `TimeValueConverter` | `TimeSpan` and SQL `TIME` | `SqlTimeValueConverter` | Extend `TimeValueConverter` |
| `BooleanValueConverter` | `boolean` and `0` / `1` | `SqlBooleanValueConverter` | Extend `BooleanValueConverter` |
| `SetValueConverter` | `string[]` and a comma-joined string | `SqlSetConverter` | Extend `SetValueConverter` |
| `DefaultValueBuilder<T>` | Column default in DDL: `date()`, `dateTime()`, `value(v)`, `raw(query)` | `SqlDefaultValueBuilder` (MySQL); `SqlLiteDefaultValueBuilder` (SQLite), `PostgresDefaultValueBuilder`, `MsSqlDefaultValueBuilder` | Subclass `SqlDefaultValueBuilder`, register `.as(DefaultValueBuilder)` |

The converter classes are exported from `@spinajs/orm-sql`. To change one, extend it or the token class from `@spinajs/orm`.

### `SqlDatetimeValueConverter`, `IsoDatetimeValueConverter`

| Call | Result |
| --- | --- |
| `toDB(null | undefined | '')`, an invalid `Date` or `DateTime` | `null` |
| `toDB(Date | DateTime | string | number)` | `toInstant()` from `@spinajs/orm`: a `DateTime` in UTC; text without an offset is UTC, a number is unix seconds; unparsable text throws `InvalidArgument` naming the column |
| with `dateTimeFormat` | `iso` `2026-10-17T09:30:00.000Z`, `sql` `2026-10-17 09:30:00.000`, `unix` seconds, all UTC |
| from `dehydrate()` (a fifth argument) without `dateTimeFormat`, so `toJSON()` | `iso`, `2026-10-17T09:30:00.000Z` |
| for a numeric column (`int`, `integer`, `float`, `double`, `decimal`, `bigint`, `smallint`, `tinyint`, `mediumint`) | Unix seconds |
| otherwise | `SqlDatetimeValueConverter`: `2026-10-17 09:30:00.000` (UTC); `IsoDatetimeValueConverter`: `2026-10-17T09:30:00.000Z` |
| `fromDB(value)` | `instantFromDb()`: `null` for a falsy value; `Date`, `DateTime`, ISO or SQL text, unix seconds to a `DateTime` in UTC |

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
| `dateTime()` | `Query = RawQuery('CURRENT_TIMESTAMP(3)')` | `DEFAULT CURRENT_TIMESTAMP(3)` (MySQL needs the precision of the `DATETIME(3)` column) |
| `value('x')`, `value(5)` | `Value` | `DEFAULT 'x'` (escaped, trimmed), `DEFAULT 5` |
| `raw(query)` | `Query` | `DEFAULT <query>` |

Each method returns the column builder, so the chain continues.

## Important behaviour

- `SqlDriver` registers the converters for every SQL connection; a dialect that stores datetimes differently (PostgreSQL, SQLite, MSSQL: `IsoDatetimeValueConverter`) registers its own after `super.resolve()`.
- `SqlBooleanValueConverter` and the datetime converters decide by argument count, not by value: a caller that passes a fifth argument gets a boolean, or an ISO 8601 datetime unless it asks for another `dateTimeFormat`.
- Datetimes are written in UTC on every dialect; the drivers run their sessions in UTC (see each driver's connection page), so SQL-side `NOW()` agrees with stored values.
- `SqlLiteralQuoter.quoteDate()` uses the connection's `DatetimeValueConverter`, so a replaced converter also changes dates inlined into view and event bodies.
- `SqlDriver` does not register `DefaultValueBuilder`; every driver registers its own (MSSQL: `MsSqlDefaultValueBuilder`, `SYSDATETIMEOFFSET()`).

## Best practices

- Keep `toDB(null)` returning `null` in your converter; the shipped converters rely on it for nullable columns.
- Implement `snapshotValue()` and `snapshotEquals()` when `fromDB()` returns a mutable object the ORM does not own, as `SqlTimeValueConverter` does.
- Register converter overrides in a driver subclass, not in the root container, so other connections keep theirs.

## Patterns and antipatterns

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

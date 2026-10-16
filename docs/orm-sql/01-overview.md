# Overview

## Where this package sits

```
@spinajs/orm          abstract WhereStatement, SelectQueryCompiler, ...
      │               resolves them from the connection's DI container
      ▼
@spinajs/orm-sql      SqlWhereStatement, SqlSelectQueryCompiler, ...   ← this package
      │               SqlDriver: execute() + all the registrations
      ▼
@spinajs/orm-sqlite   dialect overrides + connection handling
@spinajs/orm-mysql
@spinajs/orm-mssql
```

The core never instantiates a statement or compiler directly. It calls
`container.resolve(WhereStatement, [...])`, and what comes back is whatever the driver's
container has bound to that token. `SqlDriver.resolve()` binds the generic SQL implementations;
a dialect then overrides the handful that differ.

That indirection is why the core can contain no SQL at all, and why two connections on different
dialects coexist — each driver owns a **child container**.

## `SqlDriver`

An abstract `OrmDriver` that implements `execute()` in terms of one new abstract method.

```ts
export abstract class SqlDriver extends OrmDriver {
  public abstract executeOnDb(stmt: string | object, params: any[], context: QueryContext): Promise<any[] | any>;
}
```

`execute(builder)` compiles the builder and hands the result to `executeOnDb`:

1. `builder.toDB()` → `ICompilerOutput` or `ICompilerOutput[]`.
2. An **array** result (multi-statement DDL — `ALTER TABLE`, table clone, events, history
   tracking) is run through `Promise.all`, one `executeOnDb` per statement.
3. A single result is run once.
4. Either way the call is wrapped in `Perf.measure('orm.query', ...)`, labelled with `driver`
   and `context`, carrying the SQL and bindings as fields.
5. A throw is logged at `error` with the message, stack, model name and query context, then
   re-thrown.

A dialect driver therefore only has to know how to send a string with bindings to its server, plus
connect / disconnect / ping / `tableInfo` / `supportedFeatures` and the six transaction
primitives.

## What `SqlDriver.resolve()` registers

Everything below lands in the **driver's own child container**, on top of what
`OrmDriver.resolve()` already registered (`StandardModelToSqlConverter`,
`StandardObjectToSqlConverter`, `JsonValueConverter`, `UuidConverter`,
`UniversalValueConverter`).

### Statements

| Token | Implementation |
| --- | --- |
| `InStatement` | `SqlInStatement` |
| `InSetStatement` | `SqlInSetStatement` |
| `RawQueryStatement` | `SqlRawStatement` |
| `BetweenStatement` | `SqlBetweenStatement` |
| `WhereStatement` | `SqlWhereStatement` |
| `WhereQueryStatement` | `SqlWhereQueryStatement` |
| `ColumnStatement` | `SqlColumnStatement` |
| `ColumnRawStatement` | `SqlColumnRawStatement` |
| `ColumnMethodStatement` | `SqlColumnMethodStatement` |
| `ExistsQueryStatement` | `SqlExistsQueryStatement` |
| `JoinStatement` | `SqlJoinStatement` |
| `WithRecursiveStatement` | `SqlWithRecursiveStatement` |
| `GroupByStatement` | `SqlGroupByStatement` |
| `LazyQueryStatement` | `SqlLazyQueryStatement` |
| `DateWrapper` / `DateTimeWrapper` | `SqlDateWrapper` / `SqlDateTimeWrapper` |

### Compilers

| Token | Implementation |
| --- | --- |
| `SelectQueryCompiler` | `SqlSelectQueryCompiler` |
| `UpdateQueryCompiler` | `SqlUpdateQueryCompiler` |
| `DeleteQueryCompiler` | `SqlDeleteQueryCompiler` |
| `InsertQueryCompiler` | `SqlInsertQueryCompiler` |
| `OnDuplicateQueryCompiler` | `SqlOnDuplicateQueryCompiler` |
| `RecursiveQueryCompiler` | `SqlWithRecursiveCompiler` |
| `LimitQueryCompiler` | `SqlLimitQueryCompiler` |
| `OrderByQueryCompiler` | `SqlOrderByQueryCompiler` |
| `GroupByQueryCompiler` | `SqlGroupByCompiler` |
| `IndexQueryCompiler` | `SqlIndexQueryCompiler` |
| `ForeignKeyQueryCompiler` | `SqlForeignKeyQueryCompiler` |
| `TableQueryCompiler` | `SqlTableQueryCompiler` |
| `AlterTableQueryCompiler` | `SqlAlterTableQueryCompiler` |
| `ColumnQueryCompiler` | `SqlColumnQueryCompiler` |
| `AlterColumnQueryCompiler` | `SqlAlterColumnQueryCompiler` |
| `TruncateTableQueryCompiler` | `SqlTruncateTableQueryCompiler` |
| `TableCloneQueryCompiler` | `SqlTableCloneQueryCompiler` |
| `TableHistoryQueryCompiler` | `SqlTableHistoryQueryCompiler` |
| `DropTableCompiler` | `SqlDropTableQueryCompiler` |
| `DropViewCompiler` | `SqlDropViewQueryCompiler` |
| `EventQueryCompiler` | `SqlEventQueryCompiler` |
| `DropEventQueryCompiler` | `SqlDropEventQueryCompiler` |
| `RawSchemaQueryCompiler` | `SqlRawSchemaQueryCompiler` |
| `TableAliasCompiler` | `SqlTableAliasCompiler` |

### Converters and builders

| Token | Implementation |
| --- | --- |
| `DatetimeValueConverter` | `SqlDatetimeValueConverter` |
| `TimeValueConverter` | `SqlTimeValueConverter` |
| `BooleanValueConverter` | `SqlBooleanValueConverter` |
| `SetValueConverter` | `SqlSetConverter` |
| `DefaultValueBuilder` | `SqlDefaultValueBuilder` |

Notably **not** registered here: `ServerResponseMapper` and `TableExistsCompiler`. Both are
inherently dialect-specific and every driver must provide them — see
[04-writing-a-driver.md](04-writing-a-driver.md).

## Converters in detail

### `SqlBooleanValueConverter`

`toDB`: `value ? 1 : 0`.
`fromDB`: true for `1`, `true` or `'1'`.

### `SqlSetConverter`

`toDB`: joins an array with commas, passing anything else through.
`fromDB`: splits a string on commas; a non-string becomes `value ?? [value]`.

### `SqlTimeValueConverter`

Converts a `TimeSpan` (`@spinajs/util`) to and from the SQL `TIME` format. It emits
`HH:MM:SS`, and deliberately allows hours beyond 24 — MySQL `TIME` ranges from `-838:59:59` to
`838:59:59`, so a duration is representable, not just a clock reading. A value it cannot parse
becomes `null` rather than a malformed string.

### `SqlDatetimeValueConverter`

Converts between luxon `DateTime` and the database's datetime representation, honouring
`IDehydrateOptions.dateTimeFormat` (`'iso'`, `'sql'`, `'unix'`).

It handles numeric date columns — a column whose type is one of `int`, `integer`, `float`,
`double`, `decimal`, `bigint`, `smallint`, `tinyint`, `mediumint` holding a timestamp — as well
as textual ones, which is how SQLite stores datetimes.

`toDB(undefined)` and `toDB(null)` both return `null`, **not the epoch**.

## Identifier quoting

Generated SQL quotes identifiers with backticks and wraps generated table aliases in
`Options.AliasSeparator` (`$` by default):

```sql
SELECT `$users$`.`Name` FROM `users` as `$users$`
```

MSSQL cannot use either: `$` starts a pseudo-column there, and backticks are not its quoting
character. Its driver sets `AliasSeparator` to `#` in its constructor and strips backticks in
`executeOnDb`.

## Testing without a database

`toDB()` compiles without executing, which is how this package's own test suite works — build a
builder, compile it, assert on the string and the bindings.

```ts sample
import { Connection, Model, ModelBase, Primary, ICompilerOutput } from '@spinajs/orm';

@Connection('sqlite')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export function compiled(): ICompilerOutput {
  return User.where('Name', 'like', 'A%').take(10).toDB() as ICompilerOutput;
  // → { expression: "SELECT * FROM `users` ... WHERE `Name` like ? LIMIT ?", bindings: ['A%', 10] }
}
```

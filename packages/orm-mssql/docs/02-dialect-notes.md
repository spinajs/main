# Dialect notes

## Feature support

```ts
public supportedFeatures(): ISupportedFeature {
  return { events: true, insertReturning: false, insertIdIsFirstOfBatch: false };
}
```

| Feature | Value | Consequence |
| --- | --- | --- |
| `events` | `true` | Scheduled jobs are declared supported. |
| `insertReturning` | `false` | `returning()` throws `NotSupported`. |
| `insertIdIsFirstOfBatch` | `false` | `SCOPE_IDENTITY()` reports the **last** identity generated in the scope, so a multi-row insert cannot be walked forwards from it. MSSQL opts out of the positional batch backfill. |

All four isolation levels are declared.

## Compiler overrides

More than any other driver — T-SQL diverges from the generic layer in several places.

| Token | Implementation | Reason |
| --- | --- | --- |
| `TableExistsCompiler` | `MsSqlTableExistsCompiler` | Queries `sys.tables` / `INFORMATION_SCHEMA`. |
| `LimitQueryCompiler` | `MsSqlLimitCompiler` | `OFFSET ... FETCH NEXT` instead of `LIMIT`. |
| `OrderByQueryCompiler` | `MsSqlOrderByCompiler` | Bracket quoting. |
| `TableQueryCompiler` | `MsSqlTableQueryCompiler` | Table-level `UNIQUE(...)` constraints. |
| `ColumnQueryCompiler` | `MsSqlColumnQueryCompiler` | `IDENTITY(1,1)`, T-SQL types. |
| `InsertQueryCompiler` | `MsSqlInsertQueryCompiler` | `SELECT SCOPE_IDENTITY()`, upsert shape. |
| `DeleteQueryCompiler` | `MsSqlDeleteQueryCompiler` | `DELETE TOP (n)`. |
| `OnDuplicateQueryCompiler` | `MsSqlOnDuplicateQueryCompiler` | `MERGE`-style upsert. |
| `TableAliasCompiler` | `MsSqlTableAliasCompiler` | Three-part names. |
| `DatetimeValueConverter` | `MsSqlDatetimeValueConverter` | T-SQL datetime formats. |
| `ModelDehydrator` | `MssqlModelDehydrator` | Value shaping on the way out. |

Notably **absent**: `ServerResponseMapper`. See the [README](README.md).

## Paging

`MsSqlLimitCompiler` emits the T-SQL form:

```sql
OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
```

Two consequences that differ from every other driver:

**The clause is emitted only when `limit > 0`.** A `skip()` with no `take()` produces nothing at
all — no offset is applied. The generic compiler handles that case with a
`LIMIT 18446744073709551615` stand-in; this one does not. Always pair `skip()` with `take()`.

**T-SQL requires `ORDER BY` before `OFFSET`.** A paged query without a sort is a syntax error at
the server, so add one:

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mssql')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

export async function paged(page: number) {
  // ORDER BY is mandatory for OFFSET/FETCH on SQL Server.
  return await Article.select().orderBy('Id').take(25).skip(page * 25);
}
```

## `ORDER BY`

`MsSqlOrderByCompiler` emits **only the first sort entry** — it calls `getSort()`, not
`getSorts()`. Multi-column ordering is silently reduced to one column, the same limitation SQLite
has. Use a `RawQuery` when you need more.

## Limited deletes

`DELETE` has no `LIMIT` in T-SQL, so `MsSqlDeleteQueryCompiler` emits `DELETE TOP (n) FROM ...`
when the builder carries a limit.

## Inserts

`MsSqlInsertQueryCompiler` appends an identity read to every insert:

```sql
INSERT INTO [db].[dbo].[articles] ([Title]) VALUES (?); SELECT SCOPE_IDENTITY() as ID;
```

`SCOPE_IDENTITY()` is scoped to the current statement batch, so it is not affected by triggers
inserting elsewhere — but it reports the **last** identity generated, which is why
`insertIdIsFirstOfBatch` is false.

Reading that `ID` back is precisely the job of the missing `ServerResponseMapper`.

### `INSERT IGNORE` is not supported

```ts
if (this._builder.Ignore) {
  throw new OrmException(`mssql insert or ignore is not supported`);
}
```

So `InsertBehaviour.InsertOrIgnore` throws on this driver. Use `InsertOrUpdate`, or guard with an
`exists()` check.

`InsertBehaviour.InsertOrReplace` has no T-SQL equivalent either — `MsSqlOnDuplicateQueryCompiler`
implements upsert as a `MERGE`-shaped statement, which is what `InsertOrUpdate` maps onto.

## Table creation

`MsSqlTableQueryCompiler` emits table-level `UNIQUE(...)` constraints rather than inline `UNIQUE`
column modifiers, collecting every column flagged unique into one clause.

Auto-increment is `IDENTITY(1,1)`, so `table.increments('Id')` and
`table.int('Id').autoIncrement()` both produce an identity column.

## Type mapping

`MsSqlColumnQueryCompiler` maps onto T-SQL types. The important divergences from the generic
mapping:

| ORM type | T-SQL |
| --- | --- |
| `string` | `NVARCHAR(n)` |
| `text`, `longtext`, … | `NVARCHAR(MAX)` |
| `boolean` | `BIT` |
| `dateTime` | `DATETIME2` |
| `binary`, blobs | `VARBINARY` |
| `json` | `NVARCHAR(MAX)` — no native JSON column type |
| `enum` | A string column plus a `CHECK` constraint — no native `ENUM` |
| `set` | A string column — no native `SET` |

Two things follow.

**`whereInSet` / `whereNotInSet` do not work as written.** They compile to `FIND_IN_SET`, which is
MySQL-only. Model set columns as a related table on this dialect.

**`@Json()` is required for JSON columns.** There is no native JSON type to auto-detect, so the
decorator is what attaches `JsonValueConverter`.

## Datetimes

`MsSqlDatetimeValueConverter` handles the `DATETIME2` round-trip, replacing the generic
`SqlDatetimeValueConverter`. `@spinajs/orm`'s `IDehydrateOptions.dateTimeFormat` (`'iso'`,
`'sql'`, `'unix'`) is honoured.

## `MssqlModelDehydrator`

Registered over `StandardModelDehydrator`, shaping values on the way out for T-SQL's stricter
parameter typing. It is a dialect detail rather than something to configure.

## Transactions and DDL

Unlike MySQL, SQL Server DDL is fully transactional. `Migration.Transaction.Mode = PerMigration`
gives a genuinely atomic migration — a failure halfway through rolls the whole schema change
back.

## `tableInfo`

Reflection queries `INFORMATION_SCHEMA`, scoped by `Database` and `Options.Schema`, populating
`Name`, `Type`, `NativeType`, `MaxLength`, `Nullable`, `DefaultValue`, `PrimaryKey`,
`AutoIncrement` (from `IS_IDENTITY`) and `Unique`.

## Summary

| Behaviour | MSSQL |
| --- | --- |
| `ServerResponseMapper` | **Missing — inserts throw** |
| `RETURNING` | Not supported — throws |
| Batch key backfill | Not supported (`SCOPE_IDENTITY()` is the last id) |
| `INSERT IGNORE` | Throws |
| Upsert | `MERGE`-shaped, via `InsertOrUpdate` |
| Paging | `OFFSET/FETCH`; requires `ORDER BY`; `skip()` alone does nothing |
| Multi-column `ORDER BY` | Reduced to one column |
| Limited delete | `DELETE TOP (n)` |
| Identifier quoting | Backticks stripped; `[brackets]` emitted |
| Alias separator | `#` |
| Table naming | `[database].[schema].[table]` |
| Native `SET` / `ENUM` / `JSON` | None |
| DDL in a transaction | **Yes** |
| Isolation levels | All four |

# Query dialect

How `MsSqlOrmDriver` writes the parts of a query that T-SQL spells differently from the shared SQL layer: identifiers, table names, paging, sorting, limited deletes, set membership and inlined literals. Each part is a class registered in the connection's child container, so each can be replaced on its own.

## How it works

A select such as `Order.where('Status', 'paid').orderBy('PaidAt').take(20).skip(40)` compiles like this:

1. `SqlSelectQueryCompiler` (shared) assembles `SELECT ... FROM ... WHERE ... ORDER BY ... <limit>` and resolves each part from the driver's container.
2. **Identifiers.** Every compiler quotes through `IdentifierQuoter`, which is `BracketIdentifierQuoter`: `[name]`, with an embedded `]` doubled. `quoteQualified('dbo.users')` gives `[dbo].[users]`.
3. **Table name.** `MsSqlTableAliasCompiler.compile(builder)` writes `[database].` when the builder carries a database (model queries carry the connection's `Database`; `driver.select().from('t')` does not), `[schema].` when `Options.Schema` is set, then `[table]`, then ` as [alias]` when the builder has an alias. Generated aliases use the `#` separator: `[#orders#]`.
4. **Sort.** `MsSqlOrderByCompiler` writes ` ORDER BY [column] ASC|DESC` for the **first** sort only (`getSort()`).
5. **Paging.** `MsSqlLimitCompiler` writes ` OFFSET ? ROWS FETCH NEXT ? ROWS ONLY` with bindings `[max(offset, 0), limit]`, only when `limit > 0`.
6. `executeOnDb()` strips backticks and renames placeholders; see [Executing statements](02-executing-statements.md).

Result for the example, with `Database: 'shop'` and `Options.Schema: 'dbo'` on the connection:

```sql
SELECT ... FROM [shop].[dbo].[orders] as [#orders#] WHERE ... = @p0 ORDER BY [PaidAt] ASC OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY
```

### Other statements

| Builder call | Class | T-SQL |
| --- | --- | --- |
| `driver.del().from('t').where(...).take(n)` | `MsSqlDeleteQueryCompiler` | `DELETE TOP n FROM <table> WHERE ...` (no `TOP` without a limit) |
| `whereInSet('Roles', ['admin'])` | `MsSqlInSetStatement` | `(CHARINDEX(?, ',' + ISNULL([Roles], '') + ',') > 0)`, bound `',admin,'` |
| `whereNotInSet('Roles', ['admin', 'editor'])` | `MsSqlInSetStatement` | `(NOT (...) AND NOT (...))` |
| `whereInSet('Roles', [])` / negated | `MsSqlInSetStatement` | `(1 = 0)` / `(1 = 1)` |
| `whereExist('Owner', ...)` | shared `SqlExistsQueryStatement` | `EXISTS (...)` with bracket-quoted correlation `[account].[id] = [#items#].[user_id]` |
| inlined value (views, `LiteralQuoter.quote()`) | `MsSqlLiteralQuoter` | `N'it''s'`, `1` / `0` for booleans |
| `withRecursive(...)` | none registered | fails: no `RecursiveQueryCompiler` |

## Services and extension points

All registered in the driver's child container by `MsSqlOrmDriver.resolve()`; none of the MSSQL classes is exported, so a replacement extends the shared class from `@spinajs/orm-sql` or the abstract token from `@spinajs/orm`.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Identifier quoting | `IdentifierQuoter`, new instance | `BracketIdentifierQuoter` | `BacktickIdentifierQuoter` (`@spinajs/orm-sql`, not valid T-SQL) | Extend `IdentifierQuoter`, implement `quote(name)`, register `.as(IdentifierQuoter)`. |
| Literal quoting | `LiteralQuoter`, new instance | `MsSqlLiteralQuoter` | `SqlLiteralQuoter` (`@spinajs/orm-sql`, `'...'` without `N`) | Extend `SqlLiteralQuoter`, override `quoteString()`, `quoteBoolean()` or `quoteDate()`, register `.as(LiteralQuoter)`. |
| Table names | `TableAliasCompiler` | `MsSqlTableAliasCompiler` | `SqlTableAliasCompiler` (no schema) | Implement `TableAliasCompiler.compile(builder, tbl?)`, register `.as(TableAliasCompiler)`. |
| Paging | `LimitQueryCompiler`, new instance | `MsSqlLimitCompiler` | `SqlLimitQueryCompiler` (`LIMIT`, not T-SQL) | Extend `SqlLimitQueryCompiler`, override `compile()`. The builder passed in is the select builder, so `getSorts()` is available. |
| Sorting | `OrderByQueryCompiler`, new instance | `MsSqlOrderByCompiler` (first sort only) | `SqlOrderByQueryCompiler` (every sort, quoted through `IdentifierQuoter`) | Register `SqlOrderByQueryCompiler` `.as(OrderByQueryCompiler)` for multi-column sorting. |
| Deletes | `DeleteQueryCompiler`, new instance | `MsSqlDeleteQueryCompiler` | `SqlDeleteQueryCompiler` (`LIMIT`, not T-SQL) | Extend `SqlDeleteQueryCompiler`, override `compile()` or `from()`. |
| Set membership | `InSetStatement`, new instance | `MsSqlInSetStatement` | `SqlInSetStatement` (`FIND_IN_SET`, MySQL only) | Extend `InSetStatement`, implement `build()` and `clone()`, register `.as(InSetStatement)`. |
| Recursive CTE | `RecursiveQueryCompiler` | **none** | `SqlRecursiveQueryCompiler` (`WITH RECURSIVE`, not T-SQL) | Implement `RecursiveQueryCompiler` with `WITH cte AS (...)` and register it. |

### Paging: custom implementation

T-SQL rejects `OFFSET` without `ORDER BY`, and the stock compiler ignores `skip()` without `take()`. This compiler adds a neutral `ORDER BY (SELECT NULL)` when the query has no sort, and pages with `skip()` alone.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, IOrderByBuilder, LimitQueryCompiler } from '@spinajs/orm';
import { SqlLimitQueryCompiler } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@NewInstance()
export class SafePagingLimitCompiler extends SqlLimitQueryCompiler {
  public compile(): ICompilerOutput {
    const { limit = 0, offset = 0 } = this._builder.getLimits();

    if (limit <= 0 && offset <= 0) {
      return { bindings: [], expression: '' };
    }

    const sorted = (this._builder as unknown as IOrderByBuilder).getSorts().length > 0;
    const order = sorted ? '' : ' ORDER BY (SELECT NULL)';

    return limit > 0
      ? { bindings: [Math.max(offset, 0), limit], expression: `${order} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY` }
      : { bindings: [offset], expression: `${order} OFFSET ? ROWS` };
  }
}

@Injectable('orm-driver-mssql-paging')
@NewInstance()
export class PagingMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SafePagingLimitCompiler).as(LimitQueryCompiler);
  }
}
```

### Literal quoting: custom implementation

`MsSqlLiteralQuoter` writes strings as `N'...'` and refuses backticks. Replace it to change how inlined values look, for example to write dates as ODBC literals in view bodies:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { LiteralQuoter } from '@spinajs/orm';
import { SqlLiteralQuoter } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { DateTime } from 'luxon';

@NewInstance()
export class OdbcDateLiteralQuoter extends SqlLiteralQuoter {
  protected quoteString(value: string): string {
    if (value.includes('`')) {
      throw new Error('a value containing a backtick cannot be inlined on MSSQL');
    }
    return `N'${value.replace(/'/g, "''")}'`;
  }

  protected quoteDate(value: Date | DateTime): string {
    const date = value instanceof Date ? DateTime.fromJSDate(value) : value;
    return `{ts '${date.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')}'}`;
  }
}

@Injectable('orm-driver-mssql-odbc-dates')
@NewInstance()
export class OdbcDatesMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(OdbcDateLiteralQuoter).as(LiteralQuoter);
  }
}
```

## Important behaviour

- **Paging needs a sort.** `take()`, `first()` and `skip().take()` emit `OFFSET ... FETCH`, which SQL Server rejects without `ORDER BY`. The model statics `Model.get()`, `Model.first()` and `Model.last()` add a sort; a builder chain you write needs `orderBy()`.
- **`skip()` without `take()` does nothing.** No `OFFSET` clause is emitted when the limit is `0`.
- **Only the first sort is used.** `orderBy('LastName').orderBy('FirstName')` orders by `LastName` only. Register `SqlOrderByQueryCompiler` for all of them.
- **`DELETE TOP n` has no parentheses.** SQL Server requires `DELETE TOP (n)`, so `del().take(n)` fails at the server. Without `take()` the statement is a plain `DELETE`.
- **Every backtick is removed** from the statement text before sending. `MsSqlLiteralQuoter` throws `InvalidArgument` for a value containing one, instead of letting it vanish.
- **`whereInSet()` throws `InvalidArgument`** for a value containing the set delimiter `,`.
- **The schema prefix applies to every table.** One connection has one `Options.Schema`; for a table in another schema, use a second connection or a `RawQuery`.
- **Long `whereIn()` lists use `OPENJSON`.** More than 200 strings or numbers compile to `[col] IN (SELECT [value] FROM OPENJSON(?))` with the list as one JSON parameter, which needs database compatibility level 130 or later. `OPENJSON` returns `nvarchar`, so SQL Server converts per row instead of seeking an index.

## Best practices

- Put `orderBy()` on every paged builder query, on a unique column for stable pages.
- Register `SqlOrderByQueryCompiler` (see the example) on connections that sort by several columns.
- Prefer bindings over inlined literals; inlining happens only where SQL Server forbids parameters, such as view bodies.

## Patterns and antipatterns

```ts
// Don't: OFFSET without ORDER BY is a syntax error on SQL Server
const page = await driver.select().from('orders').take(20).skip(40);

// Do
const page = await driver.select().from('orders').orderBy('Id').take(20).skip(40);
```

## Examples

### Page through orders by payment date

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mssql')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;

  public PaidAt: Date;
}

export async function paidOrders(page: number, size = 20) {
  // ORDER BY is required by OFFSET ... FETCH on SQL Server
  return await Order.where('Status', 'paid').orderByDescending('PaidAt').take(size).skip(page * size);
}
```

### Sort a customer list by last and first name

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrderByQueryCompiler } from '@spinajs/orm';
import { SqlOrderByQueryCompiler } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

/** Renders every orderBy() call; the shared compiler quotes through the bracket IdentifierQuoter. */
@Injectable('orm-driver-mssql-multisort')
@NewInstance()
export class MultiSortMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
  }
}
```

With `Driver: 'orm-driver-mssql-multisort'`, `driver.select().from('customers').orderBy('LastName').orderBy('FirstName')` emits `ORDER BY [LastName] ASC, [FirstName] ASC`.

### Find users with a role in a set column

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function editors() {
  const driver = DI.get(Orm)!.Connections.get('mssql')!;
  return await driver.select().from('users').whereInSet('Roles', ['editor', 'admin']);
}
```

## Related

- [Query compilers](../orm-sql/02-query-compilers.md): every compiler token and the shared classes.
- [Statements](../orm-sql/03-statements.md): `InSetStatement` and the `clone()` contract.
- [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md): the quoter contracts.
- [Query builder](../orm/05-query-builder.md): `orderBy()`, `take()`, `skip()`, `whereInSet()`.
- [Extending the driver](08-extending-the-driver.md): the full token list and replacement rules.

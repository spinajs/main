# Executing statements

`MsSqlOrmDriver.executeOnDb()` sends one compiled statement to SQL Server. It removes backticks, renames `?` placeholders to `@p0`, `@p1`, ..., binds the values as `mssql` request inputs, and shapes the result by `QueryContext`. `toNamedParameters()` is the exported placeholder rewriter.

## How it works

1. `SqlDriver.execute(builder)` compiles the builder and calls `executeOnDb(expression, bindings, builder.QueryContext)`. See [`SqlDriver`](../orm-sql/01-sql-driver.md).
2. `executeOnDb()` removes every backtick from the statement text: `stmt.replaceAll('`', '')`.
3. It takes a new request. Inside `driver.transaction()`, `this.TransactionStorage.getStore()` holds an `IMsSqlTransactionContext` and the request comes from its `transaction.request()`. Otherwise it comes from the pool: `this._connectionPool.request()`.
4. `toNamedParameters(stmt, params.length)` replaces the first `params.length` `?` placeholders with `@p0`, `@p1`, ... in order, skipping any `?` inside a `'...'` or `"..."` literal or a `[...]` identifier.
5. Each value is bound with `req.input('p<i>', value)`. `mssql` infers the SQL type from the JavaScript value.
6. `req.query(statement)` runs it. Database errors propagate as the `mssql` error, unwrapped and not logged by the driver.
7. The result is shaped by context:

| `QueryContext` | `executeOnDb()` returns |
| --- | --- |
| `Update`, `Delete` | `{ RowsAffected: result.rowsAffected[0] }` |
| `Insert` | `{ RowsAffected: result.rowsAffected[0], LastInsertId: result.recordset[0].ID ?? 0, Returning: [] }` |
| `Select`, `Upsert`, `Schema`, `Transaction`, other | `result.recordset`: the rows of the first result set, or `undefined` for a statement with none |

`LastInsertId` comes from the `SELECT SCOPE_IDENTITY() as ID` that the insert compiler appends; see [Inserts and upserts](04-inserts-and-upserts.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Statement transport | `MsSqlOrmDriver.executeOnDb(stmt, params, context)` (public) | a new `mssql` request per statement, from the pool or from the transaction | | Override in a driver subclass. Call `super.executeOnDb()` to keep the behaviour, or re-implement it with `toNamedParameters()` and `IMsSqlTransactionContext`. |
| Retry policy | `isRetryableError(err)` (protected, from `OrmDriver`) | `isRetryableErrorCode()`: network codes such as `ECONNRESET`; none of the `mssql` codes | | Override to add `ESOCKET` / `ECONNCLOSED`, and wrap `executeOnDb()` in `this.withReconnect(...)`. |
| Placeholder rewriting | `toNamedParameters(stmt, count)`, exported function | | | Call it from your own `executeOnDb()`. |

### `toNamedParameters(stmt, count)`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `stmt` | `string` | Statement with `?` placeholders. |
| `count` | `number` | How many placeholders to rename; pass the number of bindings. |
| returns | `string` | The statement with the first `count` `?` outside literals and bracketed identifiers replaced by `@p0` ... `@p<count-1>`. |

```ts sample
import { toNamedParameters } from '@spinajs/orm-mssql';

// 'SELECT * FROM [orders] WHERE [Status] = @p0 AND [Total] > @p1'
export const sql = toNamedParameters('SELECT * FROM [orders] WHERE [Status] = ? AND [Total] > ?', 2);
```

### Statement transport: custom implementation

Override `executeOnDb()` to change how every statement on a connection is sent. Register the subclass under its own driver string and select it with `Driver`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

/** Logs statements slower than 500 ms with their SQL, for a reporting connection. */
@Injectable('orm-driver-mssql-slowlog')
@NewInstance()
export class SlowQueryLoggingMsSqlDriver extends MsSqlOrmDriver {
  public async executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const started = Date.now();

    try {
      return await super.executeOnDb(stmt, params, context);
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed > 500) {
        this.Log.warn({ elapsed, sql: stmt }, 'slow query: ${elapsed} ms');
      }
    }
  }
}
```

## Important behaviour

- **Backticks are removed from the whole statement**, including inside string literals in a `RawQuery`. Bound values are not affected, because they travel as parameters. `MsSqlLiteralQuoter` refuses to inline a value containing a backtick for the same reason; see [Query dialect](05-query-dialect.md#literal-quoting-custom-implementation).
- **`toNamedParameters()` skips a `?` inside a `'...'` or `"..."` literal or a `[...]` identifier**, with doubled quotes and `]]` read as escapes. A `?` in a comment is still counted. A `?` after the last placeholder, or in a statement with no bindings, is left alone.
- **Parameter types are inferred** by `mssql` from the JavaScript value: a `string` binds as `NVARCHAR`, a `number` as `INT` or `FLOAT`, a `Date` as a datetime type.
- **No retries.** A transport error fails the statement at once. See [the retry example](#retry-statements-after-a-dropped-connection).
- **`ping()` goes through `executeOnDb()`.** A driver whose pool is closed or `null` reports `false` instead of throwing.

## Best practices

- Pass values as bindings (`where('Name', name)`, `new RawQuery(sql, [name])`); never write them into the statement text.
- When you call `executeOnDb()` directly, write `?` placeholders and pass the bindings; the driver renames them.
- Read `this.TransactionStorage.getStore()` in an `executeOnDb()` override, so statements inside `driver.transaction()` stay on the transaction.

## Patterns and antipatterns

```ts
// Don't: a '?' in a comment before the placeholder is renamed to @p0, and the real placeholder is left as '?'
await driver.executeOnDb('SELECT * FROM [faq] /* any lang? */ WHERE [Lang] = ?', ['en'], QueryContext.Select);

// Do: keep comments out of statements with bindings
await driver.executeOnDb('SELECT * FROM [faq] WHERE [Lang] = ?', ['en'], QueryContext.Select);
```

## Examples

### Run a raw T-SQL report

`Connections.get()` is typed as `OrmDriver`; cast to `MsSqlOrmDriver` to reach `executeOnDb()`.

```ts sample
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

export async function revenueByMonth(year: number): Promise<Array<{ Month: number; Revenue: number }>> {
  const driver = DI.get(Orm)!.Connections.get('mssql') as MsSqlOrmDriver;

  return await driver.executeOnDb('SELECT MONTH([PaidAt]) AS Month, SUM([Total]) AS Revenue FROM [dbo].[orders] WHERE YEAR([PaidAt]) = ? GROUP BY MONTH([PaidAt]) ORDER BY Month', [year], QueryContext.Select);
}
```

### Retry statements after a dropped connection

`withReconnect()` (from `OrmDriver`) retries an operation when `isRetryableError()` returns `true`, calling `connect()` between attempts. The `mssql` package reports a dropped socket as `ESOCKET` or `ECONNCLOSED`, codes the default list does not contain. Never retry inside a transaction: the retried statement would run outside it.

The stock `connect()` opens a new pool without closing the previous one, so this subclass closes it first.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import mssql from 'mssql';

const MSSQL_TRANSPORT_ERRORS = new Set(['ESOCKET', 'ECONNCLOSED']);

@Injectable('orm-driver-mssql-resilient')
@NewInstance()
export class ResilientMsSqlDriver extends MsSqlOrmDriver {
  public async connect(): Promise<OrmDriver> {
    await this._connectionPool?.close().catch(() => undefined);

    this._connectionPool = await new mssql.ConnectionPool({
      server: this.Options.Host!,
      user: this.Options.User,
      password: this.Options.Password,
      database: this.Options.Database,
      options: { trustServerCertificate: this.Options.Options?.TrustServerCertificate ?? false },
    }).connect();

    return this;
  }

  public async executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    return this.withReconnect(() => super.executeOnDb(stmt, params, context));
  }

  protected isRetryableError(err: unknown): boolean {
    if (this.TransactionStorage.getStore()) {
      return false;
    }

    const code = (err as { code?: string })?.code;
    return (code !== undefined && MSSQL_TRANSPORT_ERRORS.has(code)) || super.isRetryableError(err);
  }
}
```

Set `Resilience.MaxRetries`, `RetryDelay` and `MaxRetryDelay` on the connection to tune the retries; see [Observability and resilience](../orm/13-observability-and-resilience.md).

## Related

- [`SqlDriver`](../orm-sql/01-sql-driver.md): `execute()`, query logging and the `executeOnDb()` contract.
- [Transactions](03-transactions.md): where the transaction's requests come from.
- [Inserts and upserts](04-inserts-and-upserts.md): what reads the `Insert` result.
- [Extending the driver](08-extending-the-driver.md): subclassing and registration rules.

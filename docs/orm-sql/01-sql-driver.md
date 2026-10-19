# `SqlDriver`

`SqlDriver` is the abstract base of every SQL dialect driver. It implements `OrmDriver.execute()` (compile the builder, log it, time it, send it) on top of one method you write, `executeOnDb()`, and binds the dialect-neutral statements, compilers and converters into the connection's container. Extend it to add a database; extend a shipped driver to change one dialect.

## How it works

1. **Boot.** `Orm.createConnections()` resolves the class registered under the connection's `Driver` string (eg. `'orm-driver-sqlite'`) with the connection entry as the constructor argument. `OrmDriver`'s constructor merges it into `Options` over the defaults `{ AliasSeparator: '$', Driver: 'unknown', Name: 'orm-driver', DefaultConnection: false }`.
2. **`resolve()`.** The DI container calls `resolve()` on the new driver (`OrmDriver` is a `SyncService`). `OrmDriver.resolve()` creates the `orm-driver-<Name>` logger and `this.Container`, a child of the root container, and registers the standard model and object converters. `SqlDriver.resolve()` then registers the classes in [What `SqlDriver.resolve()` registers](#what-sqldriverresolve-registers). Your driver's `resolve()` runs last and registers its dialect.
3. **Connect.** `Orm` calls `driver.connect()`, stores the driver under the connection name and starts its health check.
4. **Execute.** A builder awaited on this connection calls `SqlDriver.execute(builder)`:
   1. `builder.toDB()` compiles to one `ICompilerOutput` or an array (multi-statement DDL). See [Query compilers](02-query-compilers.md).
   2. `logQuery()` writes the SQL at `trace` to the connection's own `orm-driver-<Name>` logger.
   3. `Perf.measure('orm.query', ...)` wraps `executeOnDb(expression, bindings, builder.QueryContext)`, labelled `driver` and `context`, with `sql` and `bindings` as fields.
   4. An array is sent one `executeOnDb()` per entry, sequentially and in order; the first failure stops the rest.
5. **Result.** The promise resolves with what `executeOnDb()` returned for that `QueryContext` (rows or a status object). The builder hydrates models and runs after-hooks.

Errors: a throw while compiling (inside `toDB()`) or logging is logged at `error` with the model name and query context, then re-thrown. A rejected `executeOnDb()` promise is returned as is, not logged here.

## Configuration

`SqlDriver` reads no keys of its own. Connection keys (`Driver`, `Name`, `Host`, `Database`, `Pool`, `Resilience`, ...) belong to `OrmDriver`; see [Connections](../orm/01-connections.md).

To see every statement a connection sends, add a log rule for its logger:

```ts
export default {
  logger: {
    rules: [{ name: 'orm-driver-*', level: 'trace', target: 'Console' }],
  },
};
```

The SQL is the log message; bindings go to the structured `bindings` field only, so passwords and personal data stay out of plain console text.

## Services and extension points

### The contract

| Member | Declared by | You implement | Purpose |
| --- | --- | --- | --- |
| `executeOnDb(stmt, params, context)` | `SqlDriver` | always | Send one statement with `?` placeholders; shape the result by `QueryContext`. |
| `connect()`, `disconnect()` | `OrmDriver` | always | Open and close the handle or pool. |
| `ping()` | `OrmDriver` | always | Liveness probe for the health check. |
| `supportedFeatures()` | `OrmDriver` | always | `{ events, insertReturning, insertIdIsFirstOfBatch? }`. |
| `tableInfo(name, schema?)` | `OrmDriver` | always | Reflect a table into `IColumnDescriptor[]`, or `null` when it does not exist. |
| `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose` | `OrmDriver` | always | Transaction primitives. |
| `resolve()` | `OrmDriver`, `SqlDriver` | always | Call `super.resolve()`, then register the dialect. |
| `SupportedIsolationLevels` | `OrmDriver` | when transactions take an isolation level | Empty by default: every explicit level is rejected. |
| `poolMetrics()`, `isRetryableError()` | `OrmDriver` | optional | Pool gauges; which errors `withReconnect()` retries. |
| `execute(builder)` | `SqlDriver` | no | Compile, log, measure, send. |
| `logQuery(expression, bindings, builder)` | `SqlDriver` (protected) | optional | Override to log differently; it must never throw. |

### What `executeOnDb()` returns

| `QueryContext` | Return | Read by |
| --- | --- | --- |
| `Select` | the row array | the select builder, hydration |
| `Insert` | `{ RowsAffected, LastInsertId, Returning: [] }` | `ServerResponseMapper.read()` |
| `InsertReturning` | rows, or `{ RowsAffected, LastInsertId, Returning: rows }` | `ServerResponseMapper.read()` |
| `Upsert` | rows (SQLite, PostgreSQL) or the insert status object (MySQL) | `ServerResponseMapper.read()` |
| `Update`, `Delete` | `{ RowsAffected }` | the update and delete builders |
| `Schema`, `Transaction` | anything; callers ignore it | |

The insert shape is a convention between your `executeOnDb()` and your `ServerResponseMapper`; only the mapper's `DbServerResponse` reaches the core.

### What `SqlDriver.resolve()` registers

All in the driver's own `this.Container`, after `OrmDriver.resolve()` registered `StandardModelToSqlConverter`, `StandardObjectToSqlConverter`, `JsonValueConverter`, `UuidConverter` and `UniversalValueConverter`.

| Token | Implementation |
| --- | --- |
| `WhereStatement`, `WhereQueryStatement`, `LazyQueryStatement` | `SqlWhereStatement`, `SqlWhereQueryStatement`, `SqlLazyQueryStatement` |
| `InStatement`, `InQueryStatement`, `InSetStatement` | `SqlInStatement`, `SqlInQueryStatement`, `SqlInSetStatement` |
| `ExistsQueryStatement`, `BetweenStatement`, `RawQueryStatement` | `SqlExistsQueryStatement`, `SqlBetweenStatement`, `SqlRawStatement` |
| `ColumnStatement`, `ColumnRawStatement`, `ColumnMethodStatement` | `SqlColumnStatement`, `SqlColumnRawStatement`, `SqlColumnMethodStatement` |
| `JoinStatement`, `GroupByStatement`, `WithRecursiveStatement` | `SqlJoinStatement`, `SqlGroupByStatement`, `SqlWithRecursiveStatement` |
| `DateWrapper`, `DateTimeWrapper` | `SqlDateWrapper`, `SqlDateTimeWrapper` |
| `SelectQueryCompiler`, `InsertQueryCompiler`, `UpdateQueryCompiler`, `DeleteQueryCompiler` | `SqlSelectQueryCompiler`, `SqlInsertQueryCompiler`, `SqlUpdateQueryCompiler`, `SqlDeleteQueryCompiler` |
| `OrderByQueryCompiler`, `GroupByQueryCompiler`, `TableAliasCompiler` | `SqlOrderByQueryCompiler`, `SqlGroupByCompiler`, `SqlTableAliasCompiler` |
| `TableQueryCompiler`, `IndexQueryCompiler`, `ForeignKeyQueryCompiler` | `SqlTableQueryCompiler`, `SqlIndexQueryCompiler`, `SqlForeignKeyQueryCompiler` |
| `DropTableCompiler`, `DropViewCompiler`, `RawSchemaQueryCompiler` | `SqlDropTableQueryCompiler`, `SqlDropViewQueryCompiler`, `SqlRawSchemaQueryCompiler` |
| `CreateDatabaseCompiler`, `DropDatabaseCompiler` | `SqlCreateDatabaseQueryCompiler`, `SqlDropDatabaseQueryCompiler` |
| `DatetimeValueConverter`, `TimeValueConverter`, `BooleanValueConverter`, `SetValueConverter` | `SqlDatetimeValueConverter`, `SqlTimeValueConverter`, `SqlBooleanValueConverter`, `SqlSetConverter` |

**Not** registered, because no spelling is portable. Every driver registers these itself:

- `IdentifierQuoter`, `LiteralQuoter`, `ServerResponseMapper`, `TableExistsCompiler`, `CreateViewCompiler`.
- `LimitQueryCompiler`, `OnDuplicateQueryCompiler`, `ColumnQueryCompiler`, `AlterColumnQueryCompiler`, `AlterTableQueryCompiler`, `TruncateTableQueryCompiler`, `RecursiveQueryCompiler`, `TableCloneQueryCompiler`, `TableHistoryQueryCompiler`, `EventQueryCompiler`, `DropEventQueryCompiler`, `DefaultValueBuilder`.

A driver that leaves one of these out makes that feature fail on first use rather than emit another dialect's SQL. The per-driver matrix is in [Adding a new SQL dialect](07-adding-a-sql-dialect.md#what-each-shipped-driver-registers).

## Important behaviour

- Every registration is per connection. Two connections on different dialects coexist in one process because each driver owns its own child container.
- A registration made after `super.resolve()` replaces the one `SqlDriver` made; one made before is replaced by it.
- `execute()` is synchronous up to the returned promise: only compile errors land in its `catch`. Log database errors in `executeOnDb()` or wrap them in `OrmException`, as the shipped drivers do.
- Multi-statement DDL (`ALTER TABLE` with several changes, table history, table clone) is sent sequentially in compile order. Outside a transaction a pooled driver may still use a different connection per statement.
- `logQuery()` uses `this.Log?.trace(...)`: a driver used before `resolve()` has no logger and logs nothing instead of failing.
- `Perf.measure('orm.query')` shares the `perf` logger with other spans. Route query logs by `orm-driver-<Name>`, not by `perf`.
- The converters `SqlDriver` registers (`SqlDatetimeValueConverter`, `SqlBooleanValueConverter`, ...) are not exported from `@spinajs/orm-sql`. See [Value converters and default values](05-value-converters-and-defaults.md).

## Best practices

- Pass bindings to the database client as parameters; never interpolate them into `stmt`.
- Read the transaction context from `this.TransactionStorage.getStore()` in `executeOnDb()`, so statements inside `driver.transaction()` use the transaction's connection.
- Wrap retryable reads and writes in `this.withReconnect(...)` and return `false` from `isRetryableError()` inside a transaction, as `MySqlOrmDriver` and `PostgresOrmDriver` do.
- Call `ping()` without `withReconnect()`: the health check must see the failure, not a retry.

## Patterns and antipatterns

```ts
// Don't: overriding execute() bypasses logging, Perf spans and the array handling
public async execute(builder: Builder<any>) {
  const { expression, bindings } = builder.toDB() as ICompilerOutput;
  return this.client.query(expression!, bindings!);
}

// Do: implement executeOnDb() and let SqlDriver.execute() call it
public async executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> {
  return this.withReconnect(() => this.send(stmt, params, context));
}
```

```ts
// Don't: retrying inside a transaction replays one statement outside it
protected isRetryableError(err: unknown): boolean {
  return super.isRetryableError(err);
}

// Do
protected isRetryableError(err: unknown): boolean {
  if (this.TransactionStorage.getStore()) {
    return false;
  }
  return super.isRetryableError(err);
}
```

## Examples

### Log every statement with the model it came from

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { Builder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

/** Logs every statement's SQL at debug level, tagged with the model it came from. */
@Injectable('orm-driver-sqlite-audited')
@NewInstance()
export class AuditedSqliteDriver extends SqliteOrmDriver {
  protected logQuery(expression: string, bindings: unknown[], builder: Builder<any>) {
    super.logQuery(expression, bindings, builder);
    this.Log?.debug({ model: builder.Model?.name, bindingCount: bindings?.length ?? 0 }, '%s', expression);
  }
}
```

### Create a unique index through the driver

```ts sample
import { OrmDriver } from '@spinajs/orm';

export async function addArchiveIndex(driver: OrmDriver): Promise<void> {
  await driver.index().unique().table('invoices').name('invoices_number_uq').columns(['Number']);
}
```

## Related

- [Query compilers](02-query-compilers.md): what `toDB()` runs.
- [Adding a new SQL dialect](07-adding-a-sql-dialect.md): a complete driver on top of `SqlDriver`.
- [Connections](../orm/01-connections.md): connection options, `ISupportedFeature`, driver tokens.
- [Transactions](../orm/08-transactions.md): how `OrmDriver.transaction()` calls the primitives.
- [Observability and resilience](../orm/13-observability-and-resilience.md): `withReconnect()`, health checks, pool metrics.

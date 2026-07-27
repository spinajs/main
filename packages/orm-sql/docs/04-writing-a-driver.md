# Writing a dialect driver

What it takes to add a new database to the ORM, using the three shipped drivers as the reference.

## The contract

Extend `SqlDriver` and implement:

| Member | Purpose |
| --- | --- |
| `executeOnDb(stmt, params, context)` | Send one compiled statement to the server. |
| `connect()` / `disconnect()` | Open and close the connection or pool. |
| `ping()` | Cheap liveness probe for the health check. |
| `supportedFeatures()` | Declare `events`, `insertReturning`, `insertIdIsFirstOfBatch`. |
| `tableInfo(name, schema?)` | Reflect a table into `IColumnDescriptor[]`. |
| `_begin` `_commit` `_rollback` `_savepoint` `_releaseSavepoint` `_rollbackToSavepoint` `_dispose` | Transaction primitives. |
| `resolve()` | Register your dialect's overrides. |

Two registrations are **mandatory** and have no generic implementation:

- `ServerResponseMapper` — normalizes your insert response into
  `{ RowsAffected, LastInsertId, Returning }`. The base class throws with a message naming the
  contract, rather than dying with `read is not a function` deep inside a middleware.
- `TableExistsCompiler` — every dialect answers "does this table exist" differently.

## Skeleton

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { SqlDriver } from '@spinajs/orm-sql';
import {
  IColumnDescriptor,
  ISupportedFeature,
  IsolationLevel,
  ITransactionContext,
  ITransactionOptions,
  QueryContext,
  ServerResponseMapper,
  OrmDriver,
  IPoolMetrics,
} from '@spinajs/orm';

export class MyServerResponseMapper extends ServerResponseMapper {
  public read(data: any, _pkNames?: string[]) {
    return {
      RowsAffected: data?.affectedRows ?? 0,
      LastInsertId: data?.insertId ?? 0,
      Returning: [] as any[],
    };
  }
}

@Injectable('orm-driver-mydb')
@NewInstance()
export class MyDbOrmDriver extends SqlDriver {
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ COMMITTED', 'SERIALIZABLE'];

  public async executeOnDb(stmt: string | object, params: unknown[], _context: QueryContext): Promise<unknown> {
    // Reads and writes both go through withReconnect: it only re-runs on transport
    // failures, where the statement provably never reached the server.
    return this.withReconnect(async () => {
      void stmt;
      void params;
      return [];
    });
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: true, insertIdIsFirstOfBatch: false };
  }

  public async tableInfo(_name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    return [];
  }

  public poolMetrics(): IPoolMetrics {
    return { Size: 1, InUse: 0, Waiting: 0 };
  }

  public resolve() {
    super.resolve();
    this.Container.register(MyServerResponseMapper).as(ServerResponseMapper);
    // ... plus TableExistsCompiler and any dialect overrides
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {}

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {}

  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {}
}
```

Registering under `@Injectable('orm-driver-mydb')` is what lets a connection say
`Driver: 'orm-driver-mydb'`.

## Declaring features honestly

`ISupportedFeature` drives real behaviour, so a wrong answer produces wrong keys.

### `insertReturning`

Whether a plain `INSERT` can echo rows back. When true, the ORM asks for the primary key
columns and assigns them authoritatively. When false, `InsertQueryBuilder.returning()` throws
`NotSupported` rather than silently doing nothing.

### `insertIdIsFirstOfBatch`

Whether the identity value reported after a multi-row `INSERT ... VALUES` names the **first**
row, with the rest following contiguously.

| Driver | Value | Why |
| --- | --- | --- |
| MySQL | `true` | InnoDB treats a statement whose row count is known before execution — every `INSERT ... VALUES (…), (…)` the builder can produce — as a *simple insert*, reserves one contiguous block of auto-increment values under a short mutex, and `LAST_INSERT_ID()` reports the first. Holds under `innodb_autoinc_lock_mode = 2`, the MySQL 8 default. The manual's "values may not be contiguous" caveat is about *bulk* inserts (`INSERT … SELECT`) and mixed-mode inserts. |
| MSSQL | `false` | `SCOPE_IDENTITY()` returns the **last** identity generated in the scope. |
| SQLite | `false` | `sqlite3_last_insert_rowid()` is likewise the last row. SQLite gets its keys from `RETURNING` instead. |

The field is optional and defaults to `false`, so a driver that does not set it opts out of the
batch backfill rather than getting wrong keys.

### `events`

Whether the engine supports scheduled events. MySQL and MSSQL: true. SQLite: false.

## Isolation levels

`SupportedIsolationLevels` is empty by default, meaning **every** explicitly requested level is
rejected. Declare what you actually honour.

SQLite declares `['SERIALIZABLE']` only — sqlite3 outside shared-cache mode serializes file
access, which is SERIALIZABLE and nothing else. Requesting anything else is rejected rather than
quietly ignored.

## Transactions

`OrmDriver.transaction()` orchestrates; your primitives do the work.

- **Pooled driver**: `_begin` acquires a connection and puts it on `ctx.connection`; `_dispose`
  releases it. MySQL and MSSQL work this way.
- **Single-handle driver**: `_begin` returns a context with no connection; `_dispose` is a no-op.
  SQLite works this way.

`ctx.depth` is managed by the base class and used to mint savepoint names (`sp_1`, `sp_2`, …).

Nesting is handled for you: a `transaction()` call inside another takes a savepoint rather than
opening a second transaction.

## Retries

`withReconnect` retries only transport failures. Extend the retryable set by overriding
`isRetryableError`.

**Refuse to retry inside a transaction.** The connection carried uncommitted state, and
replaying one statement after reconnecting would apply it outside the transaction. MySQL's
driver does exactly this:

```ts
protected isRetryableError(err: unknown): boolean {
  if (this.TransactionStorage.getStore()) {
    return false;
  }
  return super.isRetryableError(err);
}
```

## Reflecting a schema

`tableInfo` is what turns undecorated model properties into real columns. Fill in as much of
`IColumnDescriptor` as the dialect exposes: `Name`, `Type`, `NativeType`, `MaxLength`,
`Nullable`, `DefaultValue`, `PrimaryKey`, `AutoIncrement`, `Unique`, `Unsigned`, `Comment`, and
`IsForeignKey` / `ForeignKeyDescription` where you can.

`NativeType` matters beyond display: the orphan-policy resolver refuses to act on a column whose
`NativeType` is empty, treating it as "the database never told us". Populate it.

SQLite reads `PRAGMA table_info`, `PRAGMA index_list` and `PRAGMA foreign_key_list`; MySQL and
MSSQL query `information_schema`.

## Common overrides

The three shipped drivers between them override roughly this set:

| Concern | Typical override |
| --- | --- |
| Identifier quoting | `TableAliasCompiler`, or string surgery in `executeOnDb` (MSSQL strips backticks) |
| Auto-increment keyword | `ColumnQueryCompiler` — `AUTO_INCREMENT` / `AUTOINCREMENT` / `IDENTITY(1,1)` |
| Upsert syntax | `OnDuplicateQueryCompiler` — `ON DUPLICATE KEY UPDATE` vs `ON CONFLICT ... DO UPDATE SET` |
| `INSERT` shape | `InsertQueryCompiler` — `RETURNING` / `OUTPUT` |
| Truncation | `TruncateTableQueryCompiler` — SQLite has no `TRUNCATE` |
| Table existence | `TableExistsCompiler` — always |
| Composite primary keys | `TableQueryCompiler` — SQLite needs a table-level constraint |
| `ALTER COLUMN` | `AlterColumnQueryCompiler` — SQLite's support is very limited |
| Date wrapping | `DateWrapper` / `DateTimeWrapper` — abstract in orm-sql |
| Joins | `JoinStatement` — SQLite lacks `RIGHT JOIN` on older engines |
| `ORDER BY` | `OrderByQueryCompiler` — collation and null ordering differ |
| Insert response | `ServerResponseMapper` — always |

Register **after** `super.resolve()`, so your binding replaces the generic one.

## Pool metrics

Override `poolMetrics()` if you own a real pool, and call `observeAcquireSeconds(seconds)` from
your acquire path. Both must never throw — they run on the health-check timer. Keeping the
prom-client objects behind those two methods is what stops every driver from needing to know
about `@spinajs/telemetry-common`.

## Testing

The three shipped drivers all split their suites:

- **Unit tests** compile builders with `toDB()` and assert on the SQL string and bindings. No
  server needed; they run everywhere.
- **Integration tests** under `test/integration/` need a live server and run from a separate
  `npm run test:integration` script, so `npm test` stays green in CI without Docker.

See the repository root [README](../../../README.md) for how the MySQL and MSSQL containers are
started.

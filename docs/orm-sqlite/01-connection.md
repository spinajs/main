# Connection and driver

`SqliteOrmDriver` is the connection class behind every `db.Connections` entry with `Driver: 'orm-driver-sqlite'`. It opens the database file, sends each compiled statement to the right `sqlite3` handle, shapes the result per `QueryContext`, and reflects tables for model metadata. Subclass it to change how a connection opens, sends or reports.

## How it works

1. **Registration.** `@Injectable('orm-driver-sqlite')` and `@NewInstance()` on `SqliteOrmDriver` register it in the root container when `@spinajs/orm-sqlite` is imported. Each connection gets its own instance.
2. **Construction.** `Orm.createConnections()` resolves `orm-driver-sqlite` with the connection entry. `OrmDriver`'s constructor merges the entry into `Options`.
3. **`resolve()`.** `OrmDriver.resolve()` creates the `orm-driver-<Name>` logger and the driver's child container `this.Container`. `SqlDriver.resolve()` registers the shared `Sql*` classes. `SqliteOrmDriver.resolve()` then registers the SQLite classes listed in [Extending the driver](07-extending-the-driver.md#what-sqliteormdriverresolve-registers).
4. **`connect()`.**
   1. Expands `Options.Filename` with `format({}, ...)` from `@spinajs/configuration`, so the path may hold configuration placeholders.
   2. Closes the writer handle left by an earlier `connect()` (a health-check reconnect), then opens the writer handle, `new sqlite3.Database(filename)`, read-write and create.
   3. On an open error it drops the handle without closing it and rejects with the `sqlite3` error (`SQLITE_CANTOPEN` for a missing directory or an unreadable file).
   4. `openReadPool()` opens the read-only handles. See [Read handle pool](02-read-pool.md).
   5. Sets `State` to `ConnectionState.Connected`.
5. **Execute.** `SqlDriver.execute()` compiles the builder and calls `executeOnDb(stmt, params, queryContext)`. `executeOnDb()` holds a writer-handle statement issued from outside an open transaction until it ends (see [Transactions](03-transactions.md#important-behaviour)), then `runStatement()` converts the bindings with `SqlDriver.toDriverParams()` (see [Schema and DDL](04-schema-and-ddl.md#value-conversion)), picks a handle with `handleFor(queryContext)` and calls the `sqlite3` method listed in [Result shapes](#result-shapes). `SQLITE_BUSY` outside a transaction is retried, see [Errors](#errors).
6. **`disconnect()`.** Stops the health check, sets `State` to `Disconnected`, closes every read handle, then closes the writer. A close error rejects.

`executeOnDb()` throws `Error('cannot execute sqlite statement, no db connection avaible')` when called before `connect()` or after `disconnect()`.

### Result shapes

| `QueryContext` | `sqlite3` call | Resolves with |
| --- | --- | --- |
| `Select` | `all()` | the row array |
| `Insert` | `run()` | `{ RowsAffected: changes, LastInsertId: lastID, Returning: [] }` |
| `InsertReturning` | `all()` | `{ RowsAffected: rows.length, LastInsertId: 0, Returning: rows }` |
| `Upsert` | `all()` | the `RETURNING` row array |
| `Update`, `Delete` | `run()` | `{ RowsAffected: changes }` |
| `Schema` without bindings | `exec()`: every statement of the string | `undefined` |
| `Schema` with bindings, `Transaction`, anything else | `run()`: the first statement only | `undefined` |

`SqliteServerResponseMapper` turns the insert shapes into `DbServerResponse`; see [Inserts, upserts and `RETURNING`](05-inserts-and-upserts.md).

### Errors

`runStatement()` rejects a failed statement with the error `mapSqliteError()` builds:

| Failure | Error | Notes |
| --- | --- | --- |
| Any, `SQLITE_CONSTRAINT` with `UNIQUE constraint failed` or `PRIMARY KEY must be unique` | `UniqueViolation` (extends `ResourceDuplicated`) | The `sqlite3` message is the exception's message and the `sqlite3` error is `inner`. `table` and `columns` come from the message; a unique index on expressions sets `constraint` to the index name instead. |
| Any, other `SQLITE_CONSTRAINT` | `ConstraintViolation` (extends `OrmException`) | `kind` is `not_null` (with `table` and `columns`), `check` (with `constraint`), `foreign_key` or `other`. |
| Any, other error | `OrmException('Failed to execute query', ...)` | The `sqlite3` error is in `inner`; `query` and `bindings` are set. |

Every `QueryContext` goes through the same mapping, `Schema` and `Transaction` included. `sqlite3` reports no extended result code, so the kind of constraint is read from the message.

`mapSqliteError(err, driverOptions, query, bindings)` is exported. Call it from a driver subclass that sends statements its own way, so its errors map like the built-in ones.

`SQLITE_BUSY` is in `RETRYABLE_ERROR_CODES`. Outside a transaction, a statement that fails with it after `sqlite3`'s own 1000 ms busy timeout runs again on the same handle, up to `Resilience.MaxRetries` times, waiting `Resilience.RetryDelay` doubled per attempt and capped at `Resilience.MaxRetryDelay`. The database is not reopened. Inside a transaction it fails on the first attempt.

### Table reflection

`Orm.reloadTableInfo()` calls `tableInfo(name, schema?)` for every model on this connection. It returns `null` when the table does not exist, otherwise one `IColumnDescriptor` per column:

| Field | Source |
| --- | --- |
| `Name`, `Type`, `NativeType` | `PRAGMA table_info`: the declared type, eg. `INTEGER`, `TEXT`, `BOOLEAN` |
| `Nullable` | `notnull = 0` |
| `PrimaryKey` | `pk > 0`; every column of a composite key |
| `AutoIncrement` | the only key column, `pk = 1`, declared `INTEGER` |
| `DefaultValue` | `dflt_value`, passed through the value converter registered for the lower-cased type in `__orm_db_value_converters__` when there is one |
| `Unique` | the column is the only column of a unique index (`PRAGMA index_list` / `PRAGMA index_info`); a column of a composite unique index is not `Unique` |
| `IsForeignKey`, `ForeignKeyDescription` | `PRAGMA foreign_key_list` (`From`, `Table`, `To`) |
| `Schema` | the `schema` argument, else `Options.Database` |
| `MaxLength` | always `-1` |

## Configuration

Keys under `db.Connections[]`. Keys shared by all drivers are described in [Connections](../orm/01-connections.md#configuration).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Connections[].Driver` | `string` | required | `orm-driver-sqlite`, or the string of a subclass | Selects `SqliteOrmDriver`. |
| `db.Connections[].Name` | `string` | required | | Connection name for `@Connection()` and logs. |
| `db.Connections[].Filename` | `string` | required | file path, `:memory:`, `''` | Database file, expanded with `format()` (`${env:NAME}`, `${cwd}`, ...). `''` is an anonymous temporary database. The parent directory must exist. |
| `db.Connections[].Pool.Max` | `number` | `10` | `>= 1` | Writer plus read-only handles: `Max - 1` read handles. See [Read handle pool](02-read-pool.md). |
| `db.Connections[].PoolLimit` | `number` | | | Deprecated `Pool.Max`. |
| `db.Connections[].Resilience.HealthCheckInterval` | `number` | `30000` | ms, `0` disables | Interval of the health probe. On SQLite the probe reads `PRAGMA schema_version` on the writer handle. |
| `db.Connections[].Resilience.MaxRetries` | `number` | `5` | `>= 0` | Retries of a statement that failed with `SQLITE_BUSY` outside a transaction. |
| `db.Connections[].Resilience.RetryDelay` | `number` | `200` | ms | First wait before a `SQLITE_BUSY` retry; doubles each attempt. |
| `db.Connections[].Resilience.MaxRetryDelay` | `number` | `5000` | ms | Upper bound of that wait. |
| `db.Connections[].Migration.*` | | | | Read by the migration service; see [Migrations](../orm/10-migrations.md). |
| `db.Connections[].AliasSeparator` | `string` | `$` | | Wraps generated table aliases, eg. `` `$users$` ``. |

Ignored by this driver: `Host`, `Port`, `User`, `Password`, `Encoding`, `SSH`, `Options`, `Pool.Min`, `Pool.IdleTimeout`, `Pool.AcquireTimeout`. `Database` is only copied into reflected `Schema` fields.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'main',
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            Pool: { Max: 4 },
            Resilience: { HealthCheckInterval: 30000 },
            Migration: {
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
    });
  }
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| SQLite driver | `'orm-driver-sqlite'` (and the class itself), new instance per connection, registered by `@Injectable` at import | `SqliteOrmDriver` | none shipped | Subclass with its own `@Injectable('<string>')` and use that string in `Driver`; or `DI.register(MyDriver).as('orm-driver-sqlite')` before `Orm` resolves to swap it for every SQLite connection. |
| Driver container | `driver.Container`, a child of the root container, one per connection | registrations of `SqliteOrmDriver.resolve()` | | Override `resolve()`, call `super.resolve()`, then register. See [Extending the driver](07-extending-the-driver.md). |

Overridable members of `SqliteOrmDriver`:

| Member | Visibility | Default behaviour | Override to |
| --- | --- | --- | --- |
| `connect()` | public | close a previous writer, open writer, open read pool, set `Connected` | configure every handle (busy timeout, pragmas) after `super.connect()` |
| `disconnect()` | public | close read pool, then writer | flush or checkpoint before `super.disconnect()` |
| `execute(builder)` | public | rebuild the table for an `alterTable()` that modifies columns (see [Schema and DDL](04-schema-and-ddl.md#alter-table-limitations)), else `SqlDriver.execute()` | intercept other builders |
| `executeOnDb(stmt, params, context)` | public | hold an outside writer statement while a transaction is open, then `runStatement()` | add tracing; call `super.executeOnDb()` |
| `runStatement(stmt, params, context)` | protected | retry `SQLITE_BUSY` outside a transaction, convert `Date` bindings, send on `handleFor(context)`, shape the result, map errors with `mapSqliteError()`; never held | map more errors |
| `usesWriter(context)` | protected | `true` for non-`Select`, inside transactions and when there are no read handles; side-effect free | route differently; both `handleFor()` and the writer gate in `executeOnDb()` follow it, so they stay in sync. See [Read handle pool](02-read-pool.md#services-and-extension-points) |
| `handleFor(context)` | protected | the writer when `usesWriter(context)`, else round-robin read handle | pick among read handles differently; to send a query to the writer, override `usesWriter()` instead, or the writer gate does not hold it |
| `beginStatement(options?)` | protected | `BEGIN TRANSACTION` | `BEGIN IMMEDIATE TRANSACTION`; see [Transactions](03-transactions.md#transaction-primitives-custom-implementation) |
| `lockTableShared(table)` | public | `DELETE FROM <table> WHERE 0` inside the transaction: takes the `RESERVED` lock | leave as is |
| `openReadPool(filename)`, `closeReadPool()` | protected | open `Max - 1` read-only handles / close them | change how read handles open |
| `supportedFeatures()` | public | `{ events: false, insertReturning: true, insertIdIsFirstOfBatch: false, nativeJson: false, concurrentTransactions: false }` | leave as is; the core picks key read-back and transaction queueing from it |
| `ping()` | public | `PRAGMA schema_version` on the writer; `false` without a writer or when it fails | probe something else |
| `tableInfo(name, schema?)` | public | `PRAGMA` reflection above | read extra metadata, eg. column collations |
| `poolMetrics()` | public | `{ Size: writer + read handles, InUse: 0, Waiting: 0 }` | report other gauges |
| `Db`, `ReadPool` | protected fields | the `sqlite3.Database` writer and the read handles | use from a subclass |

### `SqliteOrmDriver`: custom implementation

Subclass the driver when a connection needs something done to every handle or every statement. Give it its own driver string, so you choose which connections use it.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

/** Waits up to 5 s for a lock (sqlite3's default is 1 s) before failing with SQLITE_BUSY, on every handle. */
@Injectable('orm-driver-sqlite-patient')
@NewInstance()
export class PatientSqliteDriver extends SqliteOrmDriver {
  public async connect(): Promise<OrmDriver> {
    await super.connect();

    this.Db.configure('busyTimeout', 5000);
    this.ReadPool.forEach((handle) => handle.configure('busyTimeout', 5000));

    return this;
  }

}

export class PatientConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [{ Name: 'main', Driver: 'orm-driver-sqlite-patient', Filename: './data/app.sqlite', Pool: { Max: 4 } }],
      },
    });
  }
}
```

`connect()` runs again on a health-check reconnect, so keep it repeatable.

## Important behaviour

- One writer handle per connection. All writes, schema changes and transactions of the connection share it, in the order they reach `sqlite3`.
- A failed open rejects promptly with the `sqlite3` error. `Orm` then wraps it in `OrmException('Failed to connect to database for connection <Name> ...')` with the original as `inner`.
- SQLite creates the file, not its directory. A missing directory fails with `SQLITE_CANTOPEN`.
- `:memory:` and `''` give a database that exists only while the connection is open. Every `Orm` boot starts empty, so migrations run every time.
- `ping()` reads `PRAGMA schema_version` on the writer, so the health probe fails on a closed handle and on a file that is not a database. A failed probe makes the core call `connect()` again, which closes the old writer first.
- `SQLITE_BUSY` outside a transaction is retried with `Resilience.MaxRetries` / `RetryDelay` / `MaxRetryDelay`, on the same handle. Each attempt already waits `sqlite3`'s busy timeout (1000 ms), so raise the timeout (see the sample above) to wait longer per attempt.
- `Schema` statements without bindings run with `sqlite3`'s `exec()`, so `schema().raw('A; B')` runs both. With bindings, and for `Transaction` statements, `run()` executes only the first statement of the string.
- Only unique and primary-key violations become `UniqueViolation` (a `ResourceDuplicated`), on inserts, upserts and updates alike. A `NOT NULL`, `CHECK` or foreign-key failure shares the `SQLITE_CONSTRAINT` code and becomes `ConstraintViolation`.
- A `Date` binding is written as the connection's `DatetimeValueConverter` writes it, in raw SQL too. `sqlite3` alone would bind it as epoch milliseconds, which never equals a stored datetime.
- `tableInfo()` marks a column `Unique` when a unique index covers that column alone, because `onDuplicate()` without columns uses the `Unique` columns as its conflict target. Name a composite target explicitly: `onDuplicate(['A', 'B'])`. Table and index names are quoted in the `PRAGMA` calls.
- `tableInfo()` tolerates a missing `__orm_db_value_converters__` map: during the boot migration pass, before `Orm` registers converters, `DefaultValue` keeps the raw value.
- `OrmException` messages read `at undefined@undefined`, because SQLite has no `User` or `Host`.

## Best practices

- Import the package for its side effect (`import '@spinajs/orm-sqlite'`) in the module that boots `Orm`. Without the import, `Orm` throws `ORM connection driver orm-driver-sqlite not registerd`.
- Create the database directory before `Orm` resolves, eg. with `fs.mkdirSync(dir, { recursive: true })`.
- Use `Filename: ':memory:'` for tests; each `DI.resolve(Orm)` gets a clean database.
- Catch `UniqueViolation` (or `ResourceDuplicated` from `@spinajs/exceptions`) for duplicates, and `ConstraintViolation` with its `kind` for other constraint failures. Do not match on `inner.code` or the message.
- Send raw SQL that needs bindings one statement per `raw()` call.

## Patterns and antipatterns

```ts
// Don't: with bindings the statement runs through run(), which executes only the first statement
await driver.schema().raw('INSERT INTO audit (Note) VALUES (?); INSERT INTO audit (Note) VALUES (?)', ['a', 'b']);

// Do
await driver.schema().raw('INSERT INTO audit (Note) VALUES (?)', ['a']);
await driver.schema().raw('INSERT INTO audit (Note) VALUES (?)', ['b']);
```

```ts
// Don't: retrying inside a transaction is refused, so MaxRetries does not help a long transaction
await driver.transaction(async () => importEverything(driver));

// Do: commit in small transactions; a busy statement outside one is retried per Resilience
for (const batch of batches) {
  await driver.transaction(async () => importBatch(driver, batch));
}
```

## Examples

### Report a duplicate e-mail on sign-up

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, UniqueViolation } from '@spinajs/orm';

export async function signUp(email: string): Promise<'created' | 'duplicate'> {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['main'])!;

  try {
    await driver.insert().into('accounts').values({ Email: email });
    return 'created';
  } catch (err) {
    // the unique index on Email; a NOT NULL failure is a ConstraintViolation and is rethrown
    if (err instanceof UniqueViolation) {
      return 'duplicate';
    }

    throw err;
  }
}
```

### Keep one database file per environment

`connect()` expands `Filename` with `format({}, ...)` from `@spinajs/configuration`. It replaces `${name}` and `${name:option}` with registered `ConfigVariable`s: `env`, `cwd`, `pid`, `uuid`, `hostname`, `date` and others. An unknown variable becomes an empty string.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class PerEnvironmentConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'main',
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-sqlite',
            // ./data/app-production.sqlite when APP_ENV=production
            Filename: './data/app-${env:APP_ENV}.sqlite',
          },
        ],
      },
    });
  }
}
```

### Query an attached archive database

`ATTACH` runs as a `Schema` statement on the writer handle. Read handles do not see the attachment, so read the attached tables inside a transaction (which stays on the writer) or with `Pool.Max: 1`.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function closedArchiveOrders() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['main'])!;

  await driver.schema().raw(`ATTACH DATABASE './data/archive.sqlite' AS archive`);

  // database('archive') renders `archive`.`orders`; from('archive.orders') would quote it as one name
  return await driver.transaction(async () => driver.select().database('archive').from('orders').where('Status', 'closed'));
}
```

## Related

- [Read handle pool](02-read-pool.md): what `Pool.Max` opens and how `handleFor()` routes.
- [Extending the driver](07-extending-the-driver.md): every token `resolve()` registers.
- [`SqlDriver`](../orm-sql/01-sql-driver.md): `execute()`, logging and the `executeOnDb()` contract this driver implements.
- [Connections](../orm/01-connections.md): the `db.Connections` keys shared by all drivers.
- [Observability and resilience](../orm/13-observability-and-resilience.md): health probe, connection states and pool metrics.

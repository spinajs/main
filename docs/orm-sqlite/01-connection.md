# Connection and driver

`SqliteOrmDriver` is the connection class behind every `db.Connections` entry with `Driver: 'orm-driver-sqlite'`. It opens the database file, sends each compiled statement to the right `sqlite3` handle, shapes the result per `QueryContext`, and reflects tables for model metadata. Subclass it to change how a connection opens, sends or reports.

## How it works

1. **Registration.** `@Injectable('orm-driver-sqlite')` and `@NewInstance()` on `SqliteOrmDriver` register it in the root container when `@spinajs/orm-sqlite` is imported. Each connection gets its own instance.
2. **Construction.** `Orm.createConnections()` resolves `orm-driver-sqlite` with the connection entry. `OrmDriver`'s constructor merges the entry into `Options`.
3. **`resolve()`.** `OrmDriver.resolve()` creates the `orm-driver-<Name>` logger and the driver's child container `this.Container`. `SqlDriver.resolve()` registers the shared `Sql*` classes. `SqliteOrmDriver.resolve()` then registers the SQLite classes listed in [Extending the driver](07-extending-the-driver.md#what-sqliteormdriverresolve-registers).
4. **`connect()`.**
   1. Expands `Options.Filename` with `format({}, ...)` from `@spinajs/configuration`, so the path may hold configuration placeholders.
   2. Opens the writer handle, `new sqlite3.Database(filename)`, read-write and create.
   3. On an open error it drops the handle without closing it and rejects with the `sqlite3` error (`SQLITE_CANTOPEN` for a missing directory or an unreadable file).
   4. `openReadPool()` opens the read-only handles. See [Read handle pool](02-read-pool.md).
   5. Sets `State` to `ConnectionState.Connected`.
5. **Execute.** `SqlDriver.execute()` compiles the builder and calls `executeOnDb(stmt, params, queryContext)`. `executeOnDb()` holds a writer-handle statement issued from outside an open transaction until it ends (see [Transactions](03-transactions.md#important-behaviour)), then `runStatement()` picks a handle with `handleFor(queryContext)` and calls the `sqlite3` method listed in [Result shapes](#result-shapes).
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
| `Schema`, `Transaction`, anything else | `run()` | `undefined` |

`SqliteServerResponseMapper` turns the insert shapes into `DbServerResponse`; see [Inserts, upserts and `RETURNING`](05-inserts-and-upserts.md).

### Errors

| Context | Error | Notes |
| --- | --- | --- |
| Any, `SQLITE_CONSTRAINT` with `UNIQUE constraint failed` or `PRIMARY KEY must be unique` | `UniqueViolation` (extends `ResourceDuplicated`) | The `sqlite3` message is the exception's message and the `sqlite3` error is `inner`. `table` and `columns` come from the message; a unique index on expressions sets `constraint` to the index name instead. |
| Any, other `SQLITE_CONSTRAINT` | `ConstraintViolation` (extends `OrmException`) | `kind` is `not_null` (with `table` and `columns`), `check` (with `constraint`), `foreign_key` or `other`. |
| Any, other error | `OrmException('Failed to execute query', ...)` | The `sqlite3` error is in `inner`; `query` and `bindings` are set. |

`sqlite3` reports no extended result code, so the kind of constraint is read from the message.

### Table reflection

`Orm.reloadTableInfo()` calls `tableInfo(name, schema?)` for every model on this connection. It returns `null` when the table does not exist, otherwise one `IColumnDescriptor` per column:

| Field | Source |
| --- | --- |
| `Name`, `Type`, `NativeType` | `PRAGMA table_info`: the declared type, eg. `INTEGER`, `TEXT`, `BOOLEAN` |
| `Nullable` | `notnull = 0` |
| `PrimaryKey` | `pk > 0`; every column of a composite key |
| `AutoIncrement` | the only key column, `pk = 1`, declared `INTEGER` |
| `DefaultValue` | `dflt_value`, passed through the value converter registered for the lower-cased type in `__orm_db_value_converters__` when there is one |
| `Unique` | `PRAGMA index_list` / `PRAGMA index_info` |
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
| `db.Connections[].Resilience.HealthCheckInterval` | `number` | `30000` | ms, `0` disables | Interval of the health probe. On SQLite the probe only checks that the writer handle exists. |
| `db.Connections[].Migration.*` | | | | Read by the migration service; see [Migrations](../orm/10-migrations.md). |
| `db.Connections[].AliasSeparator` | `string` | `$` | | Wraps generated table aliases, eg. `` `$users$` ``. |

Ignored by this driver: `Host`, `Port`, `User`, `Password`, `Encoding`, `SSH`, `Options`, `Pool.Min`, `Pool.IdleTimeout`, `Pool.AcquireTimeout`, `Resilience.MaxRetries`, `Resilience.RetryDelay`, `Resilience.MaxRetryDelay`. `Database` is only copied into reflected `Schema` fields.

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
| `connect()` | public | open writer, open read pool, set `Connected` | configure every handle (busy timeout, pragmas) after `super.connect()` |
| `disconnect()` | public | close read pool, then writer | flush or checkpoint before `super.disconnect()` |
| `executeOnDb(stmt, params, context)` | public | hold an outside writer statement while a transaction is open, then `runStatement()` | add tracing; call `super.executeOnDb()` |
| `runStatement(stmt, params, context)` | protected | send on `handleFor(context)`, shape the result, wrap errors; never held | map more errors |
| `handleFor(context)` | protected | writer for non-`Select` and inside transactions, else round-robin read handle | route differently; see [Read handle pool](02-read-pool.md#services-and-extension-points) |
| `openReadPool(filename)`, `closeReadPool()` | protected | open `Max - 1` read-only handles / close them | change how read handles open |
| `supportedFeatures()` | public | `{ events: false, insertReturning: true, insertIdIsFirstOfBatch: false, maxBindParameters: 32766, concurrentTransactions: false }` | leave as is; the core picks key read-back from it |
| `ping()` | public | `true` while the writer handle exists | run a real query (`SELECT 1`) for the health probe |
| `tableInfo(name, schema?)` | public | `PRAGMA` reflection above | read extra metadata, eg. column collations |
| `poolMetrics()` | public | `{ Size: writer + read handles, InUse: 0, Waiting: 0 }` | report other gauges |
| `Db`, `ReadPool` | protected fields | the `sqlite3.Database` writer and the read handles | use from a subclass |

### `SqliteOrmDriver`: custom implementation

Subclass the driver when a connection needs something done to every handle or every statement. Give it its own driver string, so you choose which connections use it.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';
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

  public async ping(): Promise<boolean> {
    if (!this.Db) {
      return false;
    }

    try {
      await this.executeOnDb('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
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
- `ping()` returns `true` whenever the writer handle object exists. The health probe does not detect a deleted or corrupted file.
- `executeOnDb()` never calls `withReconnect()`. `SQLITE_BUSY` is in `RETRYABLE_ERROR_CODES`, but a statement still busy after `sqlite3`'s 1000 ms busy timeout fails on the first attempt; `Resilience.MaxRetries` has no effect on SQLite. Raise the busy timeout instead (see the sample above).
- `Schema` and `Transaction` statements use `sqlite3`'s `run()`, which executes only the **first** statement of a string. `schema().raw('A; B')` runs `A` and silently skips `B`.
- `Schema` and `Transaction` errors lose the `sqlite3` error object: catch on the message, not on `code` or `inner`.
- Unique violations raise `ResourceDuplicated` only on plain inserts. A model insert with an `auto` key uses `RETURNING` (`QueryContext.InsertReturning`) and raises `OrmException` instead.
- `tableInfo()` marks a column `Unique` when its name is a substring of a column in the **last** unique index it reads; with several unique indexes, earlier ones are lost, and a column named `Id` matches a unique `UserId`.
- `tableInfo()` interpolates the table name into `PRAGMA table_info(<name>)` unquoted.
- `tableInfo()` tolerates a missing `__orm_db_value_converters__` map: during the boot migration pass, before `Orm` registers converters, `DefaultValue` keeps the raw value.
- `OrmException` messages read `at undefined@undefined`, because SQLite has no `User` or `Host`.

## Best practices

- Import the package for its side effect (`import '@spinajs/orm-sqlite'`) in the module that boots `Orm`. Without the import, `Orm` throws `ORM connection driver orm-driver-sqlite not registerd`.
- Create the database directory before `Orm` resolves, eg. with `fs.mkdirSync(dir, { recursive: true })`.
- Use `Filename: ':memory:'` for tests; each `DI.resolve(Orm)` gets a clean database.
- Catch `ResourceDuplicated` for duplicate plain inserts, and `OrmException` with `inner.code === 'SQLITE_CONSTRAINT'` for model inserts with an `auto` key.
- Send multi-statement raw SQL one statement per `raw()` call.

## Patterns and antipatterns

```ts
// Don't: run() executes only the first statement; the index is never created
await driver.schema().raw('CREATE TABLE audit (Id INTEGER PRIMARY KEY, Note TEXT); CREATE INDEX audit_note ON audit (Note)');

// Do
await driver.schema().raw('CREATE TABLE audit (Id INTEGER PRIMARY KEY, Note TEXT)');
await driver.schema().raw('CREATE INDEX audit_note ON audit (Note)');
```

```ts
// Don't: SqliteOrmDriver never retries, so these keys do nothing against SQLITE_BUSY
{ Name: 'main', Driver: 'orm-driver-sqlite', Filename: './data/app.sqlite', Resilience: { MaxRetries: 8, RetryDelay: 50 } }

// Do: let SQLite wait for the lock itself (busy timeout on every handle, see PatientSqliteDriver)
{ Name: 'main', Driver: 'orm-driver-sqlite-patient', Filename: './data/app.sqlite' }
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
    // plain and RETURNING inserts map a unique failure the same way
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

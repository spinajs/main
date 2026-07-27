# Configuration

## Options

Only a subset of `IDriverOptions` is meaningful for a file-backed database.

| Option | Meaning |
| --- | --- |
| `Name` | Connection name — what `@Connection('...')` refers to. |
| `Driver` | `orm-driver-sqlite`, matching the DI registration. |
| `Filename` | Database file path, `:memory:`, or `''`. **Required.** |
| `Pool.Max` | Size of the **read-only** handle pool. See below. |
| `Resilience.*` | Health-check interval and retry policy. |
| `Migration.*` | `OnStartup`, `Table`, `Transaction.Mode`. |
| `AliasSeparator` | Defaults to `$`, which SQLite accepts. |

`Host`, `Port`, `User`, `Password`, `Database` and `Encoding` are ignored.

`Filename` is passed through `format({}, ...)` from `@spinajs/configuration`, so it may contain
configuration placeholders.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Name: 'sqlite',
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

## The read pool

`Pool.Max` does **not** size a pool of writer connections. SQLite serializes writers at the file
level no matter how many handles are open, so a second writer handle buys nothing and invites
`SQLITE_BUSY`. Instead the driver opens `Pool.Max - 1` **read-only** handles, so concurrent
`SELECT`s stop queueing behind each other.

`handleFor(queryContext)` picks a handle:

- Anything that is **not** a `Select` — mutations, schema changes — stays on the single writer.
- Anything inside a **transaction** stays on the writer. Scattering a transaction's statements
  across handles would run them outside the transaction, and a read handle cannot see uncommitted
  writes.
- Everything else round-robins across the read pool.

The pool is skipped entirely when:

- `Pool.Max <= 1`;
- `Filename` is `:memory:`;
- `Filename` is `''` (an anonymous temporary database).

In those last two cases each handle would open its **own private database**, so a read pool would
query empty files.

A read handle that fails to open is logged at `warn` and dropped — the driver stays fully usable
on the writer alone.

`poolMetrics()` reports `Size` as the writer plus the read handles, and `InUse` / `Waiting` as
always zero: sqlite3 serializes internally per handle and has no queue of waiting callers.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class ReadHeavyConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'sqlite',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            // 1 writer + 7 read-only handles.
            Pool: { Max: 8 },
          },
        ],
      },
    });
  }
}
```

## In-memory databases

`Filename: ':memory:'` gives a database that exists only while the connection is open — ideal
for tests. The read pool is disabled, so it runs on one handle.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Name: 'sqlite',
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Migration: { OnStartup: true, Table: 'test_migrations' },
          },
        ],
      },
    });
  }
}
```

Every `DI.resolve(Orm)` against `:memory:` starts from an empty database, so migrations run each
time — which is what makes it a clean slate per test run.

## Connection failures

`connect()` drops the handle on a failed open rather than closing it. sqlite3 never invokes the
close callback for a database that failed to open, so closing there left the connect promise
unsettled and an app pointed at a bad path, an unreadable file or a missing directory waited
**forever** instead of being told `SQLITE_CANTOPEN`. sqlite3 has already released whatever it
allocated for a failed open, so there is nothing to clean up.

The directory containing `Filename` must exist — SQLite creates the file, not the path.

## Transactions

One handle, so `_begin` returns a context with no `connection` and `_dispose` is a no-op.
Savepoints are real SQLite savepoints, so nesting works.

`SupportedIsolationLevels` is `['SERIALIZABLE']` and nothing else. sqlite3 outside shared-cache
mode serializes access to the database file, which *is* SERIALIZABLE; any other requested level
is rejected by the base driver rather than silently ignored.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function serializable() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['sqlite'])!;

  // Fine — the only level SQLite declares.
  return await driver.transaction(async () => driver.select().from('users'), { isolation: 'SERIALIZABLE' });
}
```

## Retries

`SQLITE_BUSY` is in the core's `RETRYABLE_ERROR_CODES`, so a write that lost a lock race is
retried with backoff rather than failing immediately. Tune it through `Resilience`:

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class BusyTolerantConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'sqlite',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            Resilience: { MaxRetries: 8, RetryDelay: 50, MaxRetryDelay: 2000 },
          },
        ],
      },
    });
  }
}
```

Remember that retries are suppressed inside a transaction — the connection carried uncommitted
state, and replaying a statement after reconnecting would apply it outside the transaction.

## Attaching another database

The driver supports `ATTACH`, which lets one connection query across database files.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function attach() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['sqlite'])!;

  await driver.schema().raw(`ATTACH DATABASE './data/archive.sqlite' AS archive`);

  return await driver.select().from('archive.orders').where('Status', 'closed');
}
```

Attach on the **writer** handle. Read-pool handles are separate connections and do not inherit an
attachment made on the writer.

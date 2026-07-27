# Configuration

## Options

| Option | Meaning |
| --- | --- |
| `Name` | Connection name — what `@Connection('...')` refers to. |
| `Driver` | `orm-driver-mysql`, or `orm-driver-mysql-ssh` for the tunnelling variant. |
| `Host`, `Port` | Server address. Port defaults to MySQL's own default when omitted. |
| `User`, `Password` | Credentials. `Password` is never logged. |
| `Database` | Schema name. Used to qualify generated SQL and to scope `tableInfo`. |
| `Encoding` | Connection charset, e.g. `utf8mb4`. |
| `Pool.*` | `Min`, `Max`, `IdleTimeout`, `AcquireTimeout`. |
| `Resilience.*` | Health-check interval and retry policy. |
| `Migration.*` | `OnStartup`, `Table`, `Transaction.Mode`. |
| `Options` | Passed through to `mysql2` untouched — TLS, timezone, and anything else. |
| `SSH` | Tunnel settings, for `MySqlSSHOrmDriver` only. |
| `AliasSeparator` | Defaults to `$`, which MySQL accepts. |

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'mysql',
        Connections: [
          {
            Name: 'mysql',
            Driver: 'orm-driver-mysql',
            Host: '127.0.0.1',
            Port: 3306,
            User: 'app',
            Password: 'secret',
            Database: 'app',
            Encoding: 'utf8mb4',
            Pool: { Min: 2, Max: 20, IdleTimeout: 30000, AcquireTimeout: 10000 },
            Resilience: { HealthCheckInterval: 30000, MaxRetries: 5, RetryDelay: 200, MaxRetryDelay: 5000 },
            Migration: {
              OnStartup: true,
              Table: 'spinajs_migration',
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
            Options: {
              timezone: 'Z',
              supportBigNumbers: true,
              bigNumberStrings: false,
            },
          },
        ],
      },
    });
  }
}
```

## Pooling

Unlike SQLite, this is a real connection pool of read-write connections, backed by `mysql2`.

| Option | Default | Meaning |
| --- | --- | --- |
| `Pool.Min` | `0` | Connections kept open while idle. |
| `Pool.Max` | `10` | Maximum concurrent connections. |
| `Pool.IdleTimeout` | `30000` | Milliseconds an idle connection is kept. |
| `Pool.AcquireTimeout` | `10000` | Milliseconds to wait for a free connection. |

The deprecated `PoolLimit` is still honoured when `Pool.Max` is absent, in the order
`Pool.Max` → `PoolLimit` → `10`.

`poolMetrics()` reports real numbers here, and the driver records acquire latency into the
`orm_pool_acquire_seconds` histogram. See
[the core's observability page](../../orm/docs/13-observability.md).

Size `Pool.Max` against the server's `max_connections`, remembering that every process instance
opens its own pool.

## Transactions

A pooled driver, so `_begin` **acquires a connection** and puts it on `ctx.connection`, and
`_dispose` releases it. Every statement issued inside the callback runs on that connection —
the context is carried through `AsyncLocalStorage`, so nothing has to be threaded by hand.

All four isolation levels are declared:

```ts
public readonly SupportedIsolationLevels: IsolationLevel[] = [
  'READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE',
];
```

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function isolated() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['mysql'])!;

  return await driver.transaction(
    async () => driver.select().from('ledger').where('Posted', false),
    { isolation: 'REPEATABLE READ' },
  );
}
```

Nesting takes savepoints, so `save()`, `Relation.sync()` and your own nested `transaction()`
calls compose correctly.

## Retries

`executeOnDb` wraps every statement in `withReconnect`. Reads *and* writes are both retried,
because `withReconnect` only re-runs on transport failures — where the statement provably never
reached the server.

The driver adds one rule of its own:

```ts
protected isRetryableError(err: unknown): boolean {
  // Inside a transaction the connection carried uncommitted state. Reconnecting and
  // replaying one statement would silently apply it OUTSIDE the transaction.
  if (this.TransactionStorage.getStore()) {
    return false;
  }
  // ... plus the mysql2 protocol codes
}
```

Retryable codes relevant here include `PROTOCOL_CONNECTION_LOST`, `PROTOCOL_SEQUENCE_TIMEOUT`,
`PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR`, `PROTOCOL_ENQUEUE_AFTER_QUIT`, `ER_CON_COUNT_ERROR` and
`ER_LOCK_WAIT_TIMEOUT`, alongside the Node socket errors.

## Health checks

`connect()` takes and releases a real connection, so it genuinely verifies the link — which is
why this driver may promote itself back to `Connected` on a successful reconnect rather than
waiting for the next probe.

## SSH tunnelling

`MySqlSSHOrmDriver` opens an SSH connection and forwards the MySQL port through it. Register it
under its own driver name:

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { MySqlSSHOrmDriver } from '@spinajs/orm-mysql';

export async function bootstrap() {
  DI.register(MySqlSSHOrmDriver).as('orm-driver-mysql-ssh');
  return await DI.resolve(Orm);
}
```

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class TunnelledConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'remote',
            Driver: 'orm-driver-mysql-ssh',
            // Host/Port as seen FROM the bastion — usually the database's private address.
            Host: '10.0.0.5',
            Port: 3306,
            User: 'app',
            Password: 'secret',
            Database: 'app',
            SSH: {
              Host: 'bastion.example.com',
              Port: 22,
              User: 'deploy',
              PrivateKey: '/home/deploy/.ssh/id_rsa',
            },
          },
        ],
      },
    });
  }
}
```

`resolve()` validates the configuration before any connection is attempted:

- `SSH options are not set for MySqlSSHOrmDriver` when `SSH` is absent;
- `SSH private key file X does not exist` when the key file is missing — checked with
  `fs.existsSync`.

`disconnect()` ends the SSH client after closing the pool.

Two operational notes: the forward is set up from local port `12345`, so a second tunnelled
connection in the same process will collide; and the private key must be unencrypted, since no
passphrase option is exposed.

## Migrations

`Migration.Transaction.Mode = PerMigration` wraps each migration in a transaction. Be aware that
**MySQL DDL is not transactional** — `CREATE TABLE`, `ALTER TABLE` and friends commit
implicitly, so a migration that fails halfway leaves earlier DDL applied. Keep migrations small
and idempotent-friendly rather than relying on rollback.

The migration table defaults to `spinajs_migration` and is created automatically.

## Environment-driven configuration

`@spinajs/configuration` resolves placeholders in string values, so credentials can come from
the environment rather than the file:

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class EnvConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'mysql',
            Driver: 'orm-driver-mysql',
            Host: process.env.DB_HOST ?? '127.0.0.1',
            Port: Number(process.env.DB_PORT ?? 3306),
            User: process.env.DB_USER ?? 'app',
            Password: process.env.DB_PASSWORD ?? '',
            Database: process.env.DB_NAME ?? 'app',
          },
        ],
      },
    });
  }
}
```

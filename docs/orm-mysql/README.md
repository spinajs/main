# `@spinajs/orm-mysql`

The MySQL and MariaDB driver for [`@spinajs/orm`](../orm/README.md), built on [`@spinajs/orm-sql`](../orm-sql/README.md) and `mysql2`. It ships `MySqlOrmDriver` (`orm-driver-mysql`) and `MySqlSSHOrmDriver` (`orm-driver-mysql-ssh`), which tunnels the pool through an SSH bastion.

`Encoding` becomes the `mysql2` `charset`, and `Options` is passed to `mysql2` as is, so TLS and similar settings need no subclass. Every connection runs in UTC: the driver's `timezone: 'Z'` wins over one in `Options`. It has no `RETURNING`; generated keys come from `LAST_INSERT_ID()`.

## Install

```sh
npm install @spinajs/orm @spinajs/orm-mysql
```

## Features

| Feature | What it does |
| --- | --- |
| [MySQL driver](01-mysql-driver.md) | Connection pool, UTC session zone, statement execution, error mapping to `UniqueViolation` / `ConstraintViolation`, `driver.now()`, retries, health probe, pool metrics; how to override `connect()` and the retry policy. |
| [SSH tunnel](02-ssh-tunnel.md) | `MySqlSSHOrmDriver`: the pool over a forwarded SSH channel, one forwarded channel per pooled connection. |
| [Transactions](03-transactions.md) | One pooled connection per transaction, savepoints, all four isolation levels, no retries inside. |
| [Inserts and generated keys](04-inserts-and-generated-keys.md) | `LAST_INSERT_ID()`, contiguous batch keys, `INSERT IGNORE`, `REPLACE`, `ON DUPLICATE KEY UPDATE`, the response mapper. |
| [Table reflection](05-table-reflection.md) | `tableInfo()`, `parseColumnDefault()`, `ResponseSchemaTypes`, the table-exists probe. |
| [Schema, views and events](06-schema-views-and-events.md) | Column types (`DATETIME(3)`, `TIMESTAMP(3)`), `ALTER TABLE`, table locks, views, scheduled events, non-transactional DDL. |
| [Set membership and literal quoting](07-set-membership-and-literals.md) | `FIND_IN_SET`, backslash-escaped literals, backtick identifiers, and `sql_mode` variants. |
| [Customizing the dialect](08-customizing-the-dialect.md) | Every class the driver registers, how to replace one per connection or everywhere, and what other packages read from the driver. |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'shop',
        Connections: [
          {
            Name: 'shop',
            Driver: 'orm-driver-mysql',
            Host: '127.0.0.1',
            Port: 3306,
            User: 'shop',
            Password: process.env.DB_PASSWORD ?? '',
            Database: 'shop',
            Pool: { Min: 2, Max: 20 },
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}

export async function bootstrap(): Promise<Orm> {
  // importing @spinajs/orm-mysql registered 'orm-driver-mysql'; the Orm applies the OnStartup migrations
  return await DI.resolve(Orm);
}
```

## At a glance

| Behaviour | MySQL |
| --- | --- |
| `RETURNING` | not supported; `returning()` throws `NotSupported` |
| Batch insert keys | contiguous from `LAST_INSERT_ID()`, under six guards |
| Isolation levels | all four |
| Retries | transport failures only, never inside a transaction |
| DDL in a transaction | no: implicit commit |
| Events | supported (`event_scheduler` must be `ON`) |
| Views | `OR REPLACE`, `ALGORITHM`, `SQL SECURITY`, every `CHECK OPTION`; no `IF NOT EXISTS`, no `TEMPORARY` |
| Set membership | `FIND_IN_SET` |
| `DECIMAL` values | strings |
| Session time zone | UTC (`timezone: 'Z'` and `SET time_zone = '+00:00'`); a connection that cannot be pinned fails the acquire |
| `dateTime()` / `timestamp()` columns | `DATETIME(3)` / `TIMESTAMP(3)`; a `timestamp()` without `notNull()` is written `NULL`, so it stays nullable on MySQL 5.7 |
| `driver.now()` | `UTC_TIMESTAMP(3)` |
| Duplicate key | `UniqueViolation`; NOT NULL, FK and CHECK failures `ConstraintViolation` |
| Bind-parameter limit | `MaxBindings` `65535`; `mysql2` interpolates on the client, so `max_allowed_packet` bounds a statement |
| `lockTableShared()` | `SELECT COUNT(*) ... FOR UPDATE` |

## Migration lock

The driver registers `MySqlMigrationLock` as the migration run lock ([Locking](../orm/10-migrations.md#locking)).

1. It takes `GET_LOCK('spinajs_mig_<sha1 of the lock key>', 0)`, polled, on a connection of its own from `openDedicatedConnection()`, outside the pool. GET_LOCK names are server-wide and limited to 64 characters, so the key, which names the database, is hashed. `MySqlSSHOrmDriver` opens that connection through its own SSH channel (`dedicatedConnectionOptions()`).
2. After `GET_LOCK` it also takes the lock-table row, so a process of an earlier 3.x release, which takes only the row, is kept out during a rolling deploy.
3. Before each migration it checks `IS_USED_LOCK(name) = CONNECTION_ID()` on that connection. If the connection was killed, the run stops with `MigrationLockLostException`.
4. `release()` runs `RELEASE_LOCK(name)` and ends the connection.
5. Keep mysql2's default `FOUND_ROWS` flag: do not pass `flags: '-FOUND_ROWS'` in `Options`. The lock-table row's refresh is an UPDATE through the pool that reads 0 affected rows as "another run took the row", and without the flag an UPDATE that changes nothing reports 0.

To see a holder: `SELECT IS_USED_LOCK('spinajs_mig_…')` returns the connection id, which `SHOW PROCESSLIST` lists.

## Testing

Unit tests need no server:

```sh
cd packages/orm-mysql && npm test
```

Integration tests need the MySQL container from the repository root:

```sh
docker compose --profile test up -d mysql
cd packages/orm-mysql && npm run test:integration
```

The container publishes MySQL on host port `13306`, not `3306`, so it cannot collide with a local MySQL. `ORM_TEST_MYSQL_PORT` moves it. See the [repository README](../../README.md).

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, query builder, migrations and the driver contract.
- [`@spinajs/orm-sql`](../orm-sql/README.md): the shared SQL compilers and statements this driver registers.
- [`@spinajs/orm-sqlite`](../orm-sqlite/README.md), [`@spinajs/orm-mssql`](../orm-mssql/README.md): the other SQL dialects, for comparison.

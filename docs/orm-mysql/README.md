# `@spinajs/orm-mysql`

The MySQL and MariaDB driver for [`@spinajs/orm`](../orm/README.md), built on [`@spinajs/orm-sql`](../orm-sql/README.md) and `mysql2`. It ships `MySqlOrmDriver` (`orm-driver-mysql`) and `MySqlSSHOrmDriver` (`orm-driver-mysql-ssh`), which tunnels the pool through an SSH bastion.

It does **not** pass `Encoding` or `Options` to `mysql2`: TLS, timezone and charset need a driver subclass ([example](01-mysql-driver.md#connection-setup-custom-implementation)). It has no `RETURNING`; generated keys come from `LAST_INSERT_ID()`.

## Install

```sh
npm install @spinajs/orm @spinajs/orm-mysql
```

## Features

| Feature | What it does |
| --- | --- |
| [MySQL driver](01-mysql-driver.md) | Connection pool, statement execution, retries, health probe, pool metrics; how to override `connect()` and the retry policy. |
| [SSH tunnel](02-ssh-tunnel.md) | `MySqlSSHOrmDriver`: the pool over a forwarded SSH channel, its limits and a multi-channel override. |
| [Transactions](03-transactions.md) | One pooled connection per transaction, savepoints, all four isolation levels, no retries inside. |
| [Inserts and generated keys](04-inserts-and-generated-keys.md) | `LAST_INSERT_ID()`, contiguous batch keys, `INSERT IGNORE`, `REPLACE`, `ON DUPLICATE KEY UPDATE`, the response mapper. |
| [Table reflection](05-table-reflection.md) | `tableInfo()`, `parseColumnDefault()`, `ResponseSchemaTypes`, the table-exists probe. |
| [Schema, views and events](06-schema-views-and-events.md) | Column types, `ALTER TABLE`, views, scheduled events, non-transactional DDL. |
| [Set membership and literal quoting](07-set-membership-and-literals.md) | `FIND_IN_SET`, backslash-escaped literals, backtick identifiers, and `sql_mode` variants. |
| [Customizing the dialect](08-customizing-the-dialect.md) | Every class the driver registers, how to replace one per connection or everywhere, and how other packages detect MySQL. |

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
  // importing @spinajs/orm-mysql registered 'orm-driver-mysql'
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

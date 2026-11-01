# `@spinajs/orm-mysql`

The MySQL / MariaDB dialect driver for [`@spinajs/orm`](../orm), built on
[`@spinajs/orm-sql`](../orm-sql). Ships two drivers: `MySqlOrmDriver`, and `MySqlSSHOrmDriver`
which tunnels the connection over SSH.

## Install

```bash
npm install @spinajs/orm @spinajs/orm-mysql
```

## Usage

```ts
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

DI.register(MySqlOrmDriver).as('orm-driver-mysql');
// Migration.OnStartup (below): the Orm applies the migrations as it resolves
await DI.resolve(Orm);
```

```ts
// configuration
{
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
        Pool: { Min: 2, Max: 20 },
        Migration: { OnStartup: true },
      },
    ],
  },
}
```

## What is distinctive

- **`insertIdIsFirstOfBatch: true`** — the only driver where it holds. For a *simple* insert
  (`INSERT ... VALUES (...), (...)`, the only shape the builder produces) InnoDB reserves one
  contiguous block of auto-increment values and `LAST_INSERT_ID()` reports the first, so a
  multi-row insert's keys can be read as `LAST_INSERT_ID() + index`. The ORM applies six guards
  before relying on it.
- **No `RETURNING`** — `InsertQueryBuilder.returning()` throws `NotSupported` rather than
  silently doing nothing.
- **Database events are supported**, and **all four isolation levels** are honoured.
- **Retries are suppressed inside a transaction** — replaying a statement after reconnecting
  would apply it outside the transaction.
- **DDL is not transactional.** `Migration.Transaction.Mode = PerMigration` cannot roll back a
  `CREATE TABLE`.

Only two compiler overrides are needed (`TableExistsCompiler`, `ServerResponseMapper`), which is
a fair measure of how closely the generic SQL layer tracks MySQL.

## SSH tunnelling

```ts
DI.register(MySqlSSHOrmDriver).as('orm-driver-mysql-ssh');
```

```ts
{
  Name: 'remote',
  Driver: 'orm-driver-mysql-ssh',
  Host: '10.0.0.5', Port: 3306,
  User: 'app', Password: 'secret', Database: 'app',
  SSH: { Host: 'bastion.example.com', Port: 22, User: 'deploy', PrivateKey: '/home/deploy/.ssh/id_rsa' },
}
```

The forward uses local port `12345`, so a second tunnelled connection in the same process will
collide, and the private key must be unencrypted.

## Documentation

Full documentation lives in **[docs/orm-mysql](../../docs/orm-mysql/README.md)**.

| | Page |
| --- | --- |
| 01 | [MySQL driver](../../docs/orm-mysql/01-mysql-driver.md) |
| 02 | [SSH tunnel](../../docs/orm-mysql/02-ssh-tunnel.md) |
| 03 | [Transactions](../../docs/orm-mysql/03-transactions.md) |
| 04 | [Inserts and generated keys](../../docs/orm-mysql/04-inserts-and-generated-keys.md) |
| 05 | [Table reflection](../../docs/orm-mysql/05-table-reflection.md) |
| 06 | [Schema, views and events](../../docs/orm-mysql/06-schema-views-and-events.md) |
| 07 | [Set membership and literal quoting](../../docs/orm-mysql/07-set-membership-and-literals.md) |
| 08 | [Customizing the dialect](../../docs/orm-mysql/08-customizing-the-dialect.md) |

## Development

```bash
npm test                                   # unit suite, no server needed

docker compose --profile test up -d mysql  # from the repo root
npm run test:integration
```

The container publishes MySQL on host port **13306**, deliberately not 3306, so it cannot collide
with a locally installed MySQL. Override with `ORM_TEST_MYSQL_PORT`, which moves the published
port and every suite together. See the [repository README](../../README.md).

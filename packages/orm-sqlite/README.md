# `@spinajs/orm-sqlite`

The SQLite dialect driver for [`@spinajs/orm`](../orm), built on
[`@spinajs/orm-sql`](../orm-sql).

## Install

```bash
npm install @spinajs/orm @spinajs/orm-sqlite
```

## Usage

```ts
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
await DI.resolve(Orm);
```

```ts
// configuration
{
  db: {
    DefaultConnection: 'sqlite',
    Connections: [
      {
        Name: 'sqlite',
        Driver: 'orm-driver-sqlite',
        Filename: './data/app.sqlite',   // or ':memory:'
        Pool: { Max: 4 },                // sizes the READ-ONLY handle pool
        Migration: { OnStartup: true },
      },
    ],
  },
}
```

## What is distinctive

- **`Pool.Max` sizes read-only handles, not writers.** SQLite serializes writers at the file
  level, so extra writer handles buy nothing and invite `SQLITE_BUSY`. The driver opens
  `Max - 1` read handles instead, skipped entirely for `:memory:` and anonymous temporary
  databases.
- **The only driver with `RETURNING`** (`insertReturning: true`), so generated keys come back
  exactly — including from multi-row inserts.
- **`SERIALIZABLE` is the only isolation level**, because sqlite3 outside shared-cache mode
  serializes file access and that *is* SERIALIZABLE.
- **No database events**, **no `TRUNCATE`** (a `DELETE` stands in, and the auto-increment counter
  is not reset), and **multi-column `ORDER BY` is reduced to one column**.
- **No auto-increment column inside a composite primary key** — the compiler throws rather than
  emit invalid SQL.

## Documentation

Full documentation lives in **[docs/orm-sqlite](../../docs/orm-sqlite/README.md)**.

| | Page |
| --- | --- |
| 01 | [Connection and driver](../../docs/orm-sqlite/01-connection.md) |
| 02 | [Read handle pool](../../docs/orm-sqlite/02-read-pool.md) |
| 03 | [Transactions](../../docs/orm-sqlite/03-transactions.md) |
| 04 | [Schema and DDL](../../docs/orm-sqlite/04-schema-and-ddl.md) |
| 05 | [Inserts, upserts and `RETURNING`](../../docs/orm-sqlite/05-inserts-and-upserts.md) |
| 06 | [Query dialect](../../docs/orm-sqlite/06-query-dialect.md) |
| 07 | [Extending the driver](../../docs/orm-sqlite/07-extending-the-driver.md) |

## Development

```bash
npm test                  # unit suite, no server needed
npm run test:integration  # creates and removes a temporary on-disk database
npm run build
```

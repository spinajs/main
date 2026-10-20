# `@spinajs/orm-sqlite`

The SQLite driver for [`@spinajs/orm`](../orm/README.md). `SqliteOrmDriver` opens a database file through the `sqlite3` Node package, sends the SQL that [`@spinajs/orm-sql`](../orm-sql/README.md) compiles, and registers the compilers and statements that spell it the SQLite way.

It does **not** create databases or the directory a database file lives in, run scheduled events, clone tables (`CREATE TABLE ... LIKE`) or keep history tables. Every SQLite connection has one writer handle, so writes never run in parallel.

## Install

```sh
npm install @spinajs/orm @spinajs/orm-sqlite
```

## Features

| Feature | What it does |
| --- | --- |
| [Connection and driver](01-connection.md) | `SqliteOrmDriver`: configuration, connect and disconnect, result shapes, `UniqueViolation` / `ConstraintViolation` mapping, table reflection, subclassing the driver |
| [Read handle pool](02-read-pool.md) | `Pool.Max` opens read-only handles that run `SELECT`s in parallel; `handleFor()` picks the handle |
| [Transactions](03-transactions.md) | `BEGIN` / `COMMIT` / savepoints on the writer handle, queued outermost transactions, the writer gate, `lockTable()`, `SERIALIZABLE` only |
| [Schema and DDL](04-schema-and-ddl.md) | Type mapping, ISO-8601 UTC datetimes and other value conversion, column defaults, composite keys, `ALTER TABLE` limits, truncate, views, refused `CREATE DATABASE` |
| [Inserts, upserts and `RETURNING`](05-inserts-and-upserts.md) | `INSERT OR IGNORE` / `OR REPLACE`, `ON CONFLICT ... DO UPDATE`, generated keys through `RETURNING`, splitting at 32766 bound values, the response mapper and model serialization |
| [Query dialect](06-query-dialect.md) | `ORDER BY`, joins, set membership with `instr`, `GLOB` prefixes, long `IN` lists, `driver.now()`, `Wrapper.Text`, `LIMIT` / `OFFSET`, quoting |
| [Extending the driver](07-extending-the-driver.md) | Every DI token the driver registers, how to replace one per connection or for all SQLite connections |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
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
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}

@Connection('main')
@Model('customers')
export class Customer extends ModelBase<Customer> {
  @Primary()
  public Id: number;

  public Email: string;
}

export async function listCustomers() {
  await DI.resolve(Orm);
  return await Customer.where('Email', 'like', '%@example.com');
}
```

Importing `@spinajs/orm-sqlite` registers the driver under `orm-driver-sqlite`. `Pool.Max: 4` gives one writer and three read-only handles; see [Read handle pool](02-read-pool.md).

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, query builders, migrations and the abstract tokens this driver fills in. Start with [Connections](../orm/01-connections.md).
- [`@spinajs/orm-sql`](../orm-sql/README.md): `SqlDriver` and the shared `Sql*` compilers and statements this driver extends or reuses.
- [`@spinajs/orm-mysql`](../orm-mysql/README.md), [`@spinajs/orm-mssql`](../orm-mssql/README.md): the other dialect drivers, for comparison.
- `@spinajs/di`: the container the driver and every compiler token are registered in.

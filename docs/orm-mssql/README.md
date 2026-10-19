# `@spinajs/orm-mssql`

The Microsoft SQL Server driver for [`@spinajs/orm`](../orm/README.md). `MsSqlOrmDriver` extends `SqlDriver` from [`@spinajs/orm-sql`](../orm-sql/README.md), sends statements through the `mssql` package, and registers the T-SQL compilers, quoters and converters a connection needs.

It does **not** register a `ServerResponseMapper`, so model inserts, `save()` and upserts throw after the row is written. [Inserts and upserts](04-inserts-and-upserts.md) has the mapper to register. It does **not** create tables with T-SQL column types either: column types use the shared MySQL spelling (see [Schema dialect](06-schema-dialect.md)).

## Install

```sh
npm install @spinajs/orm @spinajs/orm-mssql
```

## Features

| Feature | What it does |
| --- | --- |
| [Connection and configuration](01-configuration.md) | Registers the `orm-driver-mssql` driver; connection keys, the `mssql` pool, TLS options, `ping()`, `tableInfo()` |
| [Executing statements](02-executing-statements.md) | `executeOnDb()`: backtick stripping, `?` to `@p0` rewriting with `toNamedParameters()`, result shapes per `QueryContext` |
| [Transactions](03-transactions.md) | Four isolation levels, `SAVE TRANSACTION` savepoints, `IMsSqlTransactionContext` |
| [Inserts and upserts](04-inserts-and-upserts.md) | `SCOPE_IDENTITY()`, `MERGE` upserts, no `INSERT IGNORE`, and the missing `ServerResponseMapper` |
| [Query dialect](05-query-dialect.md) | Bracket quoting, three-part table names, `OFFSET ... FETCH`, single-column `ORDER BY`, `DELETE TOP`, `CHARINDEX` set membership, `N'...'` literals |
| [Schema dialect](06-schema-dialect.md) | `CREATE TABLE`, `IDENTITY(1,1)`, column type spelling, databases, views, table existence, unsupported schema features |
| [Value conversion](07-value-conversion.md) | `IsoDatetimeValueConverter`: `Date` and luxon `DateTime` as ISO 8601 in UTC; `MssqlModelDehydrator` |
| [Extending the driver](08-extending-the-driver.md) | Every DI token the driver registers, how to subclass `MsSqlOrmDriver`, replace one token, or replace the driver everywhere |

## Quick start

Register the driver and point a connection at it.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

export async function bootstrap() {
  DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
  return await DI.resolve(Orm);
}
```

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'mssql',
        Connections: [
          {
            Name: 'mssql',
            Driver: 'orm-driver-mssql',
            Host: '127.0.0.1',
            User: 'sa',
            Password: 'Str0ng!Passw0rd',
            Database: 'app',
            Options: { Schema: 'dbo', TrustServerCertificate: true },
          },
        ],
      },
    });
  }
}
```

## At a glance

| Behaviour | MSSQL |
| --- | --- |
| Driver string | `orm-driver-mssql` |
| `ServerResponseMapper` | Not registered: model inserts throw. Register one, see [Inserts and upserts](04-inserts-and-upserts.md). |
| `RETURNING` | Not supported: `returning()` throws `NotSupported` |
| Batch key backfill | Not supported (`insertIdIsFirstOfBatch: false`) |
| `INSERT IGNORE` | Throws `OrmException` |
| Upsert | `MERGE ... WITH (HOLDLOCK)` |
| Paging | `OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`; needs `ORDER BY`; `skip()` alone does nothing |
| Multi-column `ORDER BY` | Only the first sort is rendered |
| Identifier quoting | `[brackets]`; every backtick is stripped before sending |
| Alias separator | `#` |
| Table naming | `[database].[schema].[table]` |
| Isolation levels | All four |
| Scheduled events | Not supported: `createEvent()` / `dropEvent()` throw `MethodNotImplemented` |

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, builders, connections and transactions this driver serves.
- [`@spinajs/orm-sql`](../orm-sql/README.md): `SqlDriver` and the shared compilers this driver extends; [Extending an existing dialect](../orm-sql/08-extending-an-existing-dialect.md) covers the subclassing pattern for every driver.
- `@spinajs/di`: the container every token here is registered in.
- `@spinajs/configuration`: where `db.Connections` is read from.

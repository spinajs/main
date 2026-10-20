# `@spinajs/orm-mssql`

The Microsoft SQL Server driver for [`@spinajs/orm`](../orm/README.md). `MsSqlOrmDriver` extends `SqlDriver` from [`@spinajs/orm-sql`](../orm-sql/README.md), sends statements through the `mssql` package, and registers the T-SQL compilers, quoters and converters a connection needs.

It does **not** translate every column type to T-SQL: `dateTime()`, `timestamp()`, `string()` and `autoIncrement()` are T-SQL, most other types use the shared MySQL spelling (see [Schema dialect](06-schema-dialect.md)).

## Install

```sh
npm install @spinajs/orm @spinajs/orm-mssql
```

## Features

| Feature | What it does |
| --- | --- |
| [Connection and configuration](01-configuration.md) | Registers the `orm-driver-mssql` driver; connection keys, the `mssql` pool, TLS options, `ping()`, `tableInfo()` |
| [Executing statements](02-executing-statements.md) | `executeOnDb()`: backtick stripping, `?` to `@p0` rewriting with `toNamedParameters()`, raw `Date` parameters, result shapes per `QueryContext`, error mapping with `mapMsSqlError()` |
| [Transactions](03-transactions.md) | Four isolation levels, `SAVE TRANSACTION` savepoints, `IMsSqlTransactionContext` |
| [Inserts and upserts](04-inserts-and-upserts.md) | `SCOPE_IDENTITY()`, `MERGE` upserts, no `INSERT IGNORE`, batch splitting at 2098 parameters / 1000 rows, and `MsSqlServerResponseMapper` |
| [Query dialect](05-query-dialect.md) | Bracket quoting, three-part table names, `OFFSET ... FETCH`, single-column `ORDER BY`, `DELETE TOP`, `OPENJSON` for long `whereIn()` lists, `CHARINDEX` set membership, `NVARCHAR(4000)` text casts, `SYSDATETIMEOFFSET()` for `now()`, `N'...'` literals |
| [Schema dialect](06-schema-dialect.md) | `CREATE TABLE`, `IDENTITY(1,1)`, `DATETIMEOFFSET(3)` instants, UTC column defaults, column type spelling, databases, views, table existence, unsupported schema features |
| [Value conversion](07-value-conversion.md) | `IsoDatetimeValueConverter`: `Date`, luxon `DateTime` and datetime strings as ISO 8601 in UTC; `MssqlModelDehydrator` |
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
| `ServerResponseMapper` | `MsSqlServerResponseMapper`: passes `RowsAffected` and `LastInsertId` through; a model upsert reads no key, see [Inserts and upserts](04-inserts-and-upserts.md) |
| `RETURNING` | Not supported: `returning()` throws `NotSupported` |
| Batch key backfill | Not supported (`insertIdIsFirstOfBatch: false`) |
| Batch limits | `maxBindParameters: 2098`, `maxInsertRows: 1000`: a larger insert is split into several statements |
| Long `whereIn()` | More than 200 strings or numbers bind as one JSON parameter read with `OPENJSON(?)` |
| `driver.now()` | `SYSDATETIMEOFFSET()` |
| Datetime columns | `dateTime()` / `timestamp()` create `DATETIMEOFFSET(3)`; values are written as ISO 8601 in UTC |
| Constraint errors | `UniqueViolation` (2627, 2601), `ConstraintViolation` (515, 547), else `OrmException` |
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

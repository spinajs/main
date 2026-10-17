# `@spinajs/orm-mssql`

The Microsoft SQL Server dialect driver for [`@spinajs/orm`](../orm), built on
[`@spinajs/orm-sql`](../orm-sql).

## Known defect: inserts fail

**This driver registers no `ServerResponseMapper`.** Every driver must — the shape of an insert
response is dialect-specific and the base class has no default. Any path that reads an insert
response therefore throws:

```
no ServerResponseMapper is registered for this connection. Every driver must register one:
container.register(MyMapper).as(ServerResponseMapper)
```

That covers `Model.insert()`, `model.insert()`, `model.save()` and every upsert. It reproduces
from this package's own suite — `npm test` gives **10 passing, 2 failing**, both with that
message.

The fix is a mapper reading the `SELECT SCOPE_IDENTITY() as ID` that `MsSqlInsertQueryCompiler`
already appends to every insert, registered in `resolve()`. See
[Inserts and upserts](../../docs/orm-mssql/04-inserts-and-upserts.md#insert-response-mapper-custom-implementation) for a working implementation.

Until then, treat this driver as **read-capable only**. Selects, schema operations and
transactions all work.

## Install

```bash
npm install @spinajs/orm @spinajs/orm-mssql
```

## Usage

```ts
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
await DI.resolve(Orm);
```

```ts
// configuration
{
  db: {
    DefaultConnection: 'mssql',
    Connections: [
      {
        Name: 'mssql',
        Driver: 'orm-driver-mssql',
        Host: '127.0.0.1',
        Port: 1433,
        User: 'sa',
        Password: 'Str0ng!Passw0rd',
        Database: 'app',
        Options: { Schema: 'dbo', encrypt: false, trustServerCertificate: true },
      },
    ],
  },
}
```

## What is distinctive

- **`AliasSeparator` defaults to `#`, not `$`** — `$` begins a pseudo-column in T-SQL.
- **Backticks are stripped** from every statement before it is sent, since T-SQL quotes with
  `[brackets]`.
- **Three-part table names** — `[database].[schema].[table]`, via `Options.Schema`.
- **`OFFSET ... FETCH NEXT`** instead of `LIMIT`. It is emitted only when a limit is set, so
  `skip()` without `take()` applies no offset — and T-SQL requires an `ORDER BY` before `OFFSET`.
- **`DELETE TOP (n)`** for limited deletes.
- **`INSERT IGNORE` throws** — `InsertBehaviour.InsertOrIgnore` is unsupported.
- **Multi-column `ORDER BY` is reduced to one column.**
- **No native `SET`, `ENUM` or `JSON`**, so `whereInSet` / `whereNotInSet` do not work here and
  `@Json()` is required for JSON columns.
- **DDL *is* transactional**, unlike MySQL — `Migration.Transaction.Mode = PerMigration` gives a
  genuinely atomic migration.

## Documentation

Full documentation lives in **[docs/orm-mssql/](../../docs/orm-mssql/README.md)**.

| | Page |
| --- | --- |
| 01 | [Connection and configuration](../../docs/orm-mssql/01-configuration.md) |
| 02 | [Executing statements](../../docs/orm-mssql/02-executing-statements.md) |
| 03 | [Transactions](../../docs/orm-mssql/03-transactions.md) |
| 04 | [Inserts and upserts](../../docs/orm-mssql/04-inserts-and-upserts.md) |
| 05 | [Query dialect](../../docs/orm-mssql/05-query-dialect.md) |
| 06 | [Schema dialect](../../docs/orm-mssql/06-schema-dialect.md) |
| 07 | [Value conversion](../../docs/orm-mssql/07-value-conversion.md) |
| 08 | [Extending the driver](../../docs/orm-mssql/08-extending-the-driver.md) |

## Development

```bash
npm test        # 10 passing, 2 failing — see the defect above
npm run build
```

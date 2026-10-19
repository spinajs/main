# `@spinajs/orm-mssql`

The Microsoft SQL Server dialect driver for [`@spinajs/orm`](../orm), built on
[`@spinajs/orm-sql`](../orm-sql).

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
        Options: { Schema: 'dbo', Encrypt: false, TrustServerCertificate: true },
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
- **`OFFSET ... FETCH NEXT`** instead of `LIMIT`. A query without `orderBy()` gets
  `ORDER BY (SELECT NULL)`, since T-SQL requires an `ORDER BY` before `OFFSET`.
- **`DELETE TOP (n)`** for limited deletes.
- **`INSERT IGNORE` and `INSERT OR REPLACE` throw** — `InsertBehaviour.InsertOrIgnore` and
  `InsertOrReplace` are unsupported; upserts are a `MERGE`.
- **No native `SET`, `ENUM` or `JSON`**: they are `NVARCHAR` columns, `whereInSet` /
  `whereNotInSet` use `CHARINDEX`, and `@Json()` is required for JSON columns.
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
npm test        # mssql.test.ts needs a SQL Server on localhost
npm run build
```

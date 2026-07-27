# `@spinajs/orm-mssql` documentation

The Microsoft SQL Server dialect driver, built on [`@spinajs/orm-sql`](../../orm-sql/docs/).

| | Page | Covers |
| --- | --- | --- |
| 01 | [Configuration](01-configuration.md) | Connection options, schemas, pooling |
| 02 | [Dialect notes](02-dialect-notes.md) | Feature support, T-SQL differences, compiler overrides |

## Known defect: inserts fail

**`MsSqlOrmDriver` does not register a `ServerResponseMapper`.** Every driver must — the shape of
an insert response is dialect-specific and the base class has no default. Any code path that
reads an insert response therefore throws:

```
no ServerResponseMapper is registered for this connection. Every driver must register one:
container.register(MyMapper).as(ServerResponseMapper)
```

That covers `Model.insert()`, `model.insert()`, `model.save()` and every upsert. It is
reproducible from this package's own suite:

```
cd packages/orm-mssql && npm test
→ 10 passing, 2 failing — both with the message above
```

The fix is a mapper reading the `SELECT SCOPE_IDENTITY() as ID` that
`MsSqlInsertQueryCompiler` already appends to every insert, registered in `resolve()`:

```ts
export class MsSqlServerResponseMapper extends ServerResponseMapper {
  public read(data: any, _pkNames?: string[]) {
    const id = Array.isArray(data) ? data[data.length - 1]?.ID : data?.ID;

    return {
      RowsAffected: data?.rowsAffected?.[0] ?? (Array.isArray(data) ? data.length : 0),
      LastInsertId: typeof id === 'number' ? id : 0,
      Returning: [] as any[],
    };
  }
}

// in MsSqlOrmDriver.resolve(), after super.resolve()
this.Container.register(MsSqlServerResponseMapper).as(ServerResponseMapper);
```

Until that lands, treat this driver as **read-capable only**. Selects, schema operations and
transactions all work.

## Quick start

```bash
npm install @spinajs/orm @spinajs/orm-mssql
```

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
            Port: 1433,
            User: 'sa',
            Password: 'Str0ng!Passw0rd',
            Database: 'app',
            Options: { Schema: 'dbo', encrypt: false, trustServerCertificate: true },
          },
        ],
      },
    });
  }
}
```

## What is distinctive here

- **`AliasSeparator` defaults to `#`, not `$`.** `$` begins a pseudo-column in T-SQL, so the
  driver overrides it in its constructor.
- **Backticks are stripped** from every statement in `executeOnDb`, since T-SQL does not use them
  for quoting.
- **A three-part table name** — `database.schema.table` — via `Options.Schema`.
- **`OFFSET ... FETCH NEXT`** instead of `LIMIT`, and `DELETE TOP (n)` for limited deletes.
- **No `INSERT IGNORE`** — `orIgnore()` throws.

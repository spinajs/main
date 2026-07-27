# `@spinajs/orm-sql`

The generic SQL layer for [`@spinajs/orm`](../orm): concrete, dialect-neutral statements and
compilers, plus `SqlDriver` — the base class every dialect driver extends.

You rarely install it directly. It arrives as a dependency of
[`@spinajs/orm-sqlite`](../orm-sqlite), [`@spinajs/orm-mysql`](../orm-mysql) or
[`@spinajs/orm-mssql`](../orm-mssql).

## What it provides

- **`SqlDriver`** — implements `OrmDriver.execute()` in terms of one abstract method,
  `executeOnDb(stmt, params, context)`. A dialect driver only has to know how to send a string
  with bindings to its server.
- **Statements** — `SqlWhereStatement`, `SqlJoinStatement`, `SqlColumnStatement`,
  `SqlInStatement`, `SqlExistsQueryStatement` and the rest.
- **Compilers** — one per query shape, from `SqlSelectQueryCompiler` to
  `SqlTableHistoryQueryCompiler`.
- **Converters** — `SqlDatetimeValueConverter`, `SqlBooleanValueConverter`,
  `SqlTimeValueConverter`, `SqlSetConverter`.

`SqlDriver.resolve()` registers all of it into the driver's own child DI container, so a dialect
overrides only what genuinely differs.

## Usage

```ts
import { SqlDriver } from '@spinajs/orm-sql';
import { QueryContext, ServerResponseMapper } from '@spinajs/orm';
import { Injectable } from '@spinajs/di';

@Injectable('orm-driver-mydb')
export class MyDbOrmDriver extends SqlDriver {
  public async executeOnDb(stmt: string, params: unknown[], _context: QueryContext) {
    return this.withReconnect(() => myClient.query(stmt, params));
  }

  public resolve() {
    super.resolve();
    // Mandatory: no generic implementation exists for either of these.
    this.Container.register(MyServerResponseMapper).as(ServerResponseMapper);
    this.Container.register(MyTableExistsCompiler).as(TableExistsCompiler);
  }

  // ... connect / disconnect / ping / supportedFeatures / tableInfo
  // ... plus the six transaction primitives
}
```

## Documentation

Full documentation lives in **[docs/](docs/)**.

| | Page |
| --- | --- |
| 01 | [Overview](docs/01-overview.md) |
| 02 | [Compilers](docs/02-compilers.md) |
| 03 | [Statements](docs/03-statements.md) |
| 04 | [Writing a driver](docs/04-writing-a-driver.md) |

See also [the core's architecture page](../orm/docs/12-architecture.md) for how a query becomes
SQL, end to end.

## Development

```bash
npm test        # compiles builders and asserts on the SQL — no database required
npm run build
```

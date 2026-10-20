# `@spinajs/orm-sql`

The generic SQL layer of the ORM. `@spinajs/orm` declares statements and compilers as abstract tokens; this package supplies their dialect-neutral implementations, the quoting and literal helpers, and `SqlDriver`, the base class every SQL dialect driver extends.

It does **not** connect to any database. You install it as a dependency of a dialect driver (`@spinajs/orm-sqlite`, `@spinajs/orm-mysql`, `@spinajs/orm-mssql`, `@spinajs/orm-postgres`), or directly when you write or extend one.

## Install

```sh
npm install @spinajs/orm-sql
```

## Features

| Feature | What it does |
| --- | --- |
| [`SqlDriver`](01-sql-driver.md) | Base driver: compiles, logs, times and sends each builder; converts raw datetime bindings; binds the shared statements, compilers and converters |
| [Query compilers](02-query-compilers.md) | Turn builders into SQL; every compiler token, what it emits (including the refused update without `WHERE`), and how to write and register your own |
| [Statements](03-statements.md) | The SQL fragments builders collect: long `IN` lists, `whereStartsWith`, `Wrapper.Text`, `whereColumn` / `outer()`; the `clone()` contract; overriding one and adding a new one |
| [Identifier and literal quoting](04-identifier-and-literal-quoting.md) | `IdentifierQuoter` and `LiteralQuoter` per dialect, `BacktickIdentifierQuoter`, `SqlLiteralQuoter`, escaping helpers |
| [Value converters and default values](05-value-converters-and-defaults.md) | UTC datetime, time, boolean and set conversion; `IsoDatetimeValueConverter`; `SqlDefaultValueBuilder` for column defaults |
| [View compiler hooks](06-view-compiler-hooks.md) | `SqlCreateViewQueryCompiler` and the per-clause hooks a driver overrides |
| [Adding a new SQL dialect](07-adding-a-sql-dialect.md) | A new driver package on top of `SqlDriver`, from an empty class to a working connection: error mapping, feature flags, bind limits, `NowExpression` |
| [Extending an existing dialect](08-extending-an-existing-dialect.md) | Subclass a shipped driver, swap one compiler or statement, select it per connection |
| [Injecting your own builders](09-injecting-your-own-builders.md) | Replace `SelectQueryBuilder` and the other builders through DI, and keep your class across `clone()` |

## Quick start

Swap one compiler for one connection: SQLite's own `ORDER BY` compiler renders a single sort, the shared one renders all of them.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrderByQueryCompiler } from '@spinajs/orm';
import { SqlOrderByQueryCompiler } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-multisort')
@NewInstance()
export class MultiSortSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
  }
}
```

Then set `Driver: 'orm-driver-sqlite-multisort'` on the connection in `db.Connections`.

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, builders and the abstract tokens this package implements; see [Architecture](../orm/12-architecture.md) for the query path end to end.
- [`@spinajs/orm-sqlite`](../orm-sqlite/README.md), [`@spinajs/orm-mysql`](../orm-mysql/README.md), [`@spinajs/orm-mssql`](../orm-mssql/README.md), [`@spinajs/orm-postgres`](../orm-postgres/README.md): dialect drivers built on `SqlDriver`.
- `@spinajs/di`: the container every token here is registered in.

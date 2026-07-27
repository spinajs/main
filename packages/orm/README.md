# `@spinajs/orm`

The SpinaJS ORM core: model metadata and decorators, query builders, relations, a unit of work,
and the schema / migration layer.

It contains **no SQL**. Statements and compilers are declared abstract and resolved from each
connection's DI container, which is what lets one application run SQLite and MySQL side by side.
The SQL itself lives in [`@spinajs/orm-sql`](../orm-sql) and the driver packages above it.

## Install

```bash
npm install @spinajs/orm @spinajs/orm-sqlite
```

## Usage

```ts
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Primary, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;
}

DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
await DI.resolve(Orm);

const user = await User.getOrCreate(null, { Email: 'someone@example.com' });
const recent = await User.where('Email', 'like', '%@example.com').take(10);
```

Connections are declared under the `db` key of `@spinajs/configuration`. Resolving `Orm` opens
them, runs pending migrations, reflects each table's columns onto its model, and installs the
static methods used above.

## Documentation

Full documentation lives in **[docs/](docs/)**.

| | Page |
| --- | --- |
| 01 | [Getting started](docs/01-getting-started.md) |
| 02 | [Configuration](docs/02-configuration.md) |
| 03 | [Models and decorators](docs/03-models-and-decorators.md) |
| 04 | [Static model API](docs/04-static-model-api.md) |
| 05 | [Instance API](docs/05-instance-api.md) |
| 06 | [Query builder](docs/06-query-builder.md) |
| 07 | [Relations](docs/07-relations.md) |
| 08 | [Unit of work](docs/08-unit-of-work.md) |
| 09 | [Transactions](docs/09-transactions.md) |
| 10 | [Schema and migrations](docs/10-schema-and-migrations.md) |
| 11 | [Converters and hydration](docs/11-converters-and-hydration.md) |
| 12 | [Architecture](docs/12-architecture.md) |
| 13 | [Observability](docs/13-observability.md) |

## Related packages

| Package | Purpose |
| --- | --- |
| [`@spinajs/orm-sql`](../orm-sql) | Shared SQL statements and compilers |
| [`@spinajs/orm-sqlite`](../orm-sqlite) | SQLite driver |
| [`@spinajs/orm-mysql`](../orm-mysql) | MySQL / MariaDB driver |
| [`@spinajs/orm-mssql`](../orm-mssql) | SQL Server driver |
| [`@spinajs/orm-http`](../orm-http) | Route arguments, filtering and DTO relations for `@spinajs/http` |
| [`@spinajs/orm-api`](../orm-api) | CRUD controller building blocks |

## Development

```bash
npm test                    # unit suite, no database required
npm run build               # compile to lib/
npm run docs:check          # from the repo root: type-check every documentation sample
```

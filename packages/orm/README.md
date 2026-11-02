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
them, reflects each table's columns onto its model, and installs the static methods used above.
It first applies the pending migrations of the connections with `Migration.OnStartup`; their
`data()` seeds run once it is resolved (`orm.Migrator.ready()` settles after them).

## Documentation

Full documentation lives in **[docs/](../../docs/orm/)**.

| Feature | What it does |
| --- | --- |
| [Connections](../../docs/orm/01-connections.md) | Boots `Orm`, opens the configured connections and binds models to them |
| [Models](../../docs/orm/02-models.md) | Declares a model class over a table: primary keys, timestamps, soft delete, archiving, hidden and historical columns |
| [Model API](../../docs/orm/03-model-api.md) | Static and instance methods on `ModelBase`: get, find, where, insert, update, destroy, scopes |
| [Converters and hydration](../../docs/orm/04-converters-and-hydration.md) | Converts column values between the database and JS, and maps rows to models and back |
| [Query builder](../../docs/orm/05-query-builder.md) | Builds select, insert, update and delete queries, and hooks query and model middleware |
| [Scopes and builder extensions](../../docs/orm/16-scopes-and-builder-extensions.md) | Adds your own methods to query builders: per-model scopes, prototype extensions, builder subclasses |
| [Relations](../../docs/orm/06-relations.md) | Declares belongs-to, one-to-many and many-to-many relations, populates them and queries by them |
| [Unit of work](../../docs/orm/07-unit-of-work.md) | Saves a model graph in dependency order with dirty tracking, an identity map and orphan policies |
| [Transactions](../../docs/orm/08-transactions.md) | Runs queries and saves atomically, with isolation levels |
| [Schema builder](../../docs/orm/09-schema-builder.md) | Creates and alters tables, columns, indexes, foreign keys, views, events and databases |
| [Migrations](../../docs/orm/10-migrations.md) | Discovers, orders, locks and runs migrations, per environment |
| [JSON schema](../../docs/orm/11-json-schema.md) | Builds a JSON schema from a model for validation |
| [Architecture](../../docs/orm/12-architecture.md) | How a query becomes SQL, and the extension points a dialect driver implements |
| [Observability and resilience](../../docs/orm/13-observability-and-resilience.md) | Pool metrics, connection state and retry with backoff |
| [Discrimination maps](../../docs/orm/14-discrimination-maps.md) | Hydrates rows of one table into different model subclasses by a discriminator column |
| [Metadata models](../../docs/orm/15-metadata-models.md) | Key-value metadata attached to a model through a relation |

## Related packages

| Package | Purpose |
| --- | --- |
| [`@spinajs/orm-sql`](../orm-sql) | Shared SQL statements and compilers |
| [`@spinajs/orm-sqlite`](../orm-sqlite) | SQLite driver |
| [`@spinajs/orm-mysql`](../orm-mysql) | MySQL / MariaDB driver |
| [`@spinajs/orm-mssql`](../orm-mssql) | SQL Server driver |
| [`@spinajs/orm-http`](../orm-http) | Route arguments, filtering and DTO relations for `@spinajs/http` |

## Development

```bash
npm test                    # unit suite, no database required
npm run build               # compile to lib/
npm run docs:check          # from the repo root: type-check every documentation sample
```

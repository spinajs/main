# `@spinajs/orm`

The core ORM: models declared with decorators, a fluent query builder, relations, a unit of work with dirty tracking, transactions, a schema builder and migrations.

It contains **no SQL** and talks to no database on its own. Statements and compilers are abstract; a dialect driver (`@spinajs/orm-sqlite`, `@spinajs/orm-mysql`, `@spinajs/orm-mssql`, built on `@spinajs/orm-sql`) supplies them.

## Install

```sh
npm install @spinajs/orm @spinajs/orm-sqlite
```

Pick the driver package for your database.

## Features

| Feature | What it does |
| --- | --- |
| [Connections](01-connections.md) | Boots `Orm`, opens the configured connections, binds models to them and reads their table info; gates model queries on `Migration.OnStartup` connections until `OrmMigrator` ran |
| [Models](02-models.md) | Declares a model class over a table: primary keys, timestamps, soft delete, archiving, hidden and historical columns |
| [Model API](03-model-api.md) | Static and instance methods on `ModelBase`: get, find, where, insert, update, destroy, scopes |
| [Converters and hydration](04-converters-and-hydration.md) | Converts column values between the database and JS, and maps rows to models and back |
| [Query builder](05-query-builder.md) | Builds select, insert, update and delete queries, and hooks query and model middleware |
| [Scopes and builder extensions](16-scopes-and-builder-extensions.md) | Adds your own methods to query builders: per-model scopes, prototype extensions, builder subclasses |
| [SQL helpers](17-sql-helpers.md) | Dialect expressions (`SqlExpressions`), affected rows, duplicate keys, SQL fragments, composite-key `IN`, chunked writes and purges for stores that use a connection directly |
| [Relations](06-relations.md) | Declares belongs-to, one-to-many and many-to-many relations, populates them and queries by them |
| [Unit of work](07-unit-of-work.md) | Saves a model graph in dependency order with dirty tracking, an identity map and orphan policies |
| [Transactions](08-transactions.md) | Runs queries and saves atomically, with isolation levels and shared table locks |
| [Schema builder](09-schema-builder.md) | Creates and alters tables, columns, indexes, foreign keys, views, events and databases |
| [Migrations](10-migrations.md) | `OrmMigrator`: discovers, orders, locks and runs migrations and their seeds, re-reads the touched models, checks the tables |
| [JSON schema](11-json-schema.md) | Builds a JSON schema from a model for validation |
| [Architecture](12-architecture.md) | How a query becomes SQL, and the extension points a dialect driver implements |
| [Observability and resilience](13-observability-and-resilience.md) | Pool metrics, connection state and retry with backoff |
| [Discrimination maps](14-discrimination-maps.md) | Hydrates rows of one table into different model subclasses by a discriminator column |
| [Metadata models](15-metadata-models.md) | Key-value metadata attached to a model through a relation |

## Quick start

```ts sample
import { Connection, CreatedAt, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Number: string;

  public Status: string;

  @CreatedAt()
  public CreatedAt: DateTime;
}

export async function latestUnpaidInvoices(): Promise<Invoice[]> {
  return await Invoice.where('Status', 'unpaid').orderByDescending('CreatedAt').take(50);
}
```

Boot `Orm` and configure the `sqlite` connection first: see [Connections](01-connections.md).

## Related packages

- [`@spinajs/orm-sql`](../orm-sql/README.md): dialect-neutral SQL statements, compilers and the `SqlDriver` base class.
  - [Adding a new SQL dialect](../orm-sql/07-adding-a-sql-dialect.md): write a driver package for another database.
  - [Extending an existing dialect](../orm-sql/08-extending-an-existing-dialect.md): change one compiler or statement of a shipped driver.
  - [Injecting your own builders](../orm-sql/09-injecting-your-own-builders.md): replace query builders through DI.
  - [Query compilers](../orm-sql/02-query-compilers.md): how builders become SQL, and custom compilers.
  - [Statements](../orm-sql/03-statements.md): the SQL fragments builders collect, and custom statements.
- [`@spinajs/orm-sqlite`](../orm-sqlite/README.md): SQLite driver.
- [`@spinajs/orm-mysql`](../orm-mysql/README.md): MySQL driver.
- [`@spinajs/orm-mssql`](../orm-mssql/README.md): Microsoft SQL Server driver.
- [`@spinajs/orm-http`](../orm-http/README.md): loads models from request arguments, declarative filtering and DTO fields resolved to entities.

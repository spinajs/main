# `@spinajs/orm` documentation

The ORM core: model metadata, query builders, relations, the unit of work, and the schema /
migration layer. It contains no SQL — dialects live in [`@spinajs/orm-sql`](../../orm-sql/docs/)
and the driver packages below it.

## Reading order

Start at the top if the ORM is new to you. Each page stands alone once you have read
[01-getting-started.md](01-getting-started.md).

| | Page | What it covers |
| --- | --- | --- |
| 01 | [Getting started](01-getting-started.md) | Install, configure a connection, define a model and a migration, run the first query |
| 02 | [Configuration](02-configuration.md) | `db.Connections`, pools, resilience, migration options, aliases, discovery |
| 03 | [Models and decorators](03-models-and-decorators.md) | Every decorator, the model descriptor, inheritance rules |
| 04 | [Static model API](04-static-model-api.md) | `Model.where()`, `get`, `insert`, `count`, `destroy`, … — the whole static surface |
| 05 | [Instance API](05-instance-api.md) | `insert`, `update`, `save`, `destroy`, dirty tracking, snapshots, dehydration |
| 06 | [Query builder](06-query-builder.md) | Select / insert / update / delete builders, `where` family, joins, aggregates, raw SQL |
| 07 | [Relations](07-relations.md) | `@BelongsTo`, `@HasMany`, `@HasManyToMany`, `@Recursive`, `@Query`, `@Virtual`, populate |
| 08 | [Unit of work](08-unit-of-work.md) | What `save()` does: subject building, sorting, execution, orphan policy, identity map |
| 09 | [Transactions](09-transactions.md) | `transaction()`, nesting via savepoints, isolation levels |
| 10 | [Schema and migrations](10-schema-and-migrations.md) | The `orm.Migration` facade, batches, locking, failure recovery, and the complete schema builder surface |
| 11 | [Converters and hydration](11-converters-and-hydration.md) | Value converters, hydrators, dehydrators, model↔SQL conversion |
| 12 | [Architecture](12-architecture.md) | How a query becomes SQL, the DI registration map, middleware hooks |
| 13 | [Observability](13-observability.md) | Metrics, connection state, retry and health checks, logging |

## The shortest possible example

```ts sample
import { Connection, Model, ModelBase, Primary, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  @CreatedAt()
  public CreatedAt: DateTime;
}

export async function example() {
  const user = await User.getOrCreate(null, { Email: 'someone@example.com' });
  const active = await User.where('Email', 'like', '%@example.com').orderByDescending('CreatedAt').take(10);

  return { user, active };
}
```

## Related packages

- [`@spinajs/orm-sql`](../../orm-sql/docs/) — the shared SQL statement and compiler layer
- [`@spinajs/orm-sqlite`](../../orm-sqlite/docs/), [`@spinajs/orm-mysql`](../../orm-mysql/docs/),
  [`@spinajs/orm-mssql`](../../orm-mssql/docs/) — dialect drivers
- [`@spinajs/orm-cli`](../../orm-cli/README.md) — `migrate-up` / `migrate-down` / `migrate-status`
  / `migrate-resolve` / `migrate-create` over the `orm.Migration` facade
- [`@spinajs/orm-http`](../../orm-http/docs/) — exposing models over HTTP
- [`@spinajs/orm-api`](../../orm-api/docs/) — CRUD controller building blocks

## Verifying the samples

Every fenced block marked ` ```ts sample ` in these files is extracted and type-checked
against the built packages:

```bash
npm run build        # packages resolve to each other's lib/ output
npm run docs:check
```

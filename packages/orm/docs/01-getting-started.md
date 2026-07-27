# Getting started

## Install

The core alone has no dialect. Install it together with a driver.

```bash
npm install @spinajs/orm @spinajs/orm-sqlite
```

`@spinajs/orm-sql` comes in as a dependency of every driver — you rarely install it directly.

## The three moving parts

1. **Configuration** declares connections under `db.Connections`.
2. **`Orm`** is a DI service. Resolving it opens every connection, discovers models and
   migrations, runs pending migrations, and reflects each table's columns back onto its model.
3. **Models** are classes decorated with `@Model` and `@Connection`.

Nothing works before `Orm` has resolved — a model's static methods are installed onto the class
*by* `Orm.resolve()`, so calling `User.where(...)` beforehand throws `Not implemented`.

## Configure a connection

Connections live under the `db` key. The driver name is a DI registration key, not a package
name — that is why the driver class has to be registered before `Orm` resolves.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        // Name of the connection that answers to `@Connection('default')`.
        DefaultConnection: 'main',
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            Migration: {
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
    });
  }
}
```

Every option is listed in [02-configuration.md](02-configuration.md).

## Bootstrap

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

export class AppConfig extends FrameworkConfiguration {}

export async function bootstrap(): Promise<Orm> {
  DI.register(AppConfig).as(Configuration);

  // The `Driver` string in the connection config resolves against this registration.
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

  // Opens connections, runs migrations, reflects table info, installs model statics.
  return await DI.resolve(Orm);
}
```

`DI.resolve(Orm)` is idempotent — `Orm` is a service, so the second call returns the same
instance. Call `orm.dispose()` on shutdown to stop the health checks and close the pools.

## Write a migration

A migration's class name must end in a `yyyy_MM_dd_HH_mm_ss` stamp; the ORM parses it to order
migrations and refuses to load one that does not match.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('main')
export class CreateUsers_2026_07_27_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('users', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Email', 255).notNull().unique();
      table.string('Name', 128).notNull();
      table.dateTime('CreatedAt').notNull();
      table.dateTime('DeletedAt');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('users');
  }
}
```

`@Migration('main')` registers the class under the `__migrations__` DI key and binds it to the
`main` connection. See [10-schema-and-migrations.md](10-schema-and-migrations.md) for the whole
schema-builder surface and the migration lifecycle.

## Define a model

The column list is **not** taken from the class. `Orm.resolve()` reflects the real table with
`driver.tableInfo()` and merges the result with whatever the decorators declared. A property
with no decorator is still a column as long as the database has one by that name.

```ts sample
import { Connection, Model, ModelBase, Primary, CreatedAt, SoftDelete } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('main')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @SoftDelete()
  public DeletedAt: DateTime;
}
```

`@Model` registers the class under the `__models__` DI key, which is how `Orm` finds it without
an explicit import list.

## Query

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('main')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

export async function queries() {
  // One row by primary key. `get` resolves undefined when missing, `getOrFail` throws.
  const byId = await User.get(1);

  // A builder is thenable — awaiting it executes it. It executes at most once.
  const admins = await User.where('Email', 'like', '%@admin.example').take(20);

  // Aggregates.
  const total = await User.count();

  // Insert one row and read the generated key back off the instance.
  const fresh = new User({ Email: 'new@example.com', Name: 'New' });
  await fresh.insert();

  return { byId, admins, total, id: fresh.Id };
}
```

## What to read next

- Adding relations → [07-relations.md](07-relations.md)
- Saving a whole object graph in one transaction → [08-unit-of-work.md](08-unit-of-work.md)
- The full query surface → [06-query-builder.md](06-query-builder.md)

## Common first-run failures

| Message | Cause |
| --- | --- |
| `ORM connection driver orm-driver-x not registerd` | The driver class was not registered under the string used in `Driver`. |
| `Not implemented` from a static method | `Orm` has not resolved yet, so `MODEL_STATIC_MIXINS` were never installed. |
| `model X does not have model descriptor. Use @model decorator on class` | `@Model` missing on the class. |
| `type Y not found for relation R in model X` | The relation's target model was never discovered — it needs `@Model` too. |
| `Migration file F have invalid name format` | The class name has no `yyyy_MM_dd_HH_mm_ss` suffix. |
| `Cannot find connection C in connection list` | The model's `@Connection` name is not in `db.Connections` (nor an alias). |

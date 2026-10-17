# Mutex table and migration

Every `OrmMutex` lock is a row of the `__mutex__` table, read and written through the exported `__mutex__` model. The package ships the migration that creates the table. Use the model to list or clean up locks, and your own migration to change the table.

## How it works

1. Importing `@spinajs/orm-threading` runs two decorators:
   - `@Model('__mutex__')` registers the `__mutex__` class under `__models__`; `@Connection('default')` binds it to the `default` connection.
   - `@Migration('default')` registers `Mutex_2024_12_03_11_41_00` under `__migrations__`.
2. `Orm.resolve()` finds the migration through `DiRegistryMigrationSource`; no directory scan is needed.
3. The boot pass runs it when the connection has `Migration.OnStartup: true`. Otherwise run it with the ORM migration commands.
4. `Mutex_2024_12_03_11_41_00.up()` creates the table. `down()` does nothing.
5. `Orm` binds the model to the driver stored under `default`, which is the connection named in `db.DefaultConnection`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.DefaultConnection` | `string` | unset | a connection `Name` | The connection stored as `default`; the table and the model live there. |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Runs the pending `__mutex__` migration at boot. |

See [Connections](../orm/01-connections.md#configuration) and [Migrations](../orm/10-migrations.md) for the rest of these sections.

```ts
this.Config = _.merge(this.Config, {
  db: {
    DefaultConnection: 'main',
    Connections: [
      {
        Name: 'main',
        Driver: 'orm-driver-mysql',
        Migration: { OnStartup: true },
      },
    ],
  },
});
```

## Schema

### `__mutex__`

| Column | Type | Meaning |
| --- | --- | --- |
| `Name` | `VARCHAR(32)`, primary key, unique, not null | Lock name; the model's primary key. |
| `Tenant` | `VARCHAR(32)`, not null | Current or last owner. |
| `Locked` | `BOOLEAN`, not null, default `0` | `true` while the owner holds the lock. |
| `Created_at` | `DATETIME`, not null, default current time | Set on insert; `@CreatedAt` on the model. |
| `Updated_at` | `DATETIME`, not null, default current time | `@UpdatedAt` on the model. Changes only on an instance `update()`, not on `OrmMutex.acquire()` or `release()`. |

### The `__mutex__` model

| Member | Decorator | Type |
| --- | --- | --- |
| class `__mutex__` | `@Connection('default')`, `@Model('__mutex__')` | `ModelBase<__mutex__>` |
| `Name` | `@Primary()` | `string` |
| `Tenant` | none | `string` |
| `Locked` | none | `boolean` |
| `Created_at` | `@CreatedAt()` | Luxon `DateTime` |
| `Updated_at` | `@UpdatedAt()` | Luxon `DateTime` |

The constructor fills `Created_at` and `Updated_at` with `DateTime.now()` unless the data passed in sets them.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `__mutex__` model | `__models__` list, registered by `@Model` on import | `__mutex__` | none | Use it directly for reads and admin writes. `OrmMutex` references the class itself, so a subclass model is **not** picked up; change the table with a migration instead. |
| `Mutex_2024_12_03_11_41_00` migration | `__migrations__` list, registered by `@Migration('default')` on import | creates `__mutex__` | none | Add your own later migration on `default` to alter the table. Its `down()` is empty. |

### Migration: widen the name and tenant columns

`VARCHAR(32)` is short for task names such as `task-recalculate-warehouse-stock` or tenants built from a host name. Add a later migration that widens both columns. The class name's timestamp must be after `2024_12_03_11_41_00`.

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('default')
export class WidenMutexColumns_2026_10_17_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Name', 128).notNull().modify();
    });

    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Tenant', 128).notNull().modify();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Tenant', 32).notNull().modify();
    });

    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Name', 32).notNull().modify();
    });
  }
}
```

Each column gets its own `alterTable()` call, because the statements of one call are sent concurrently. SQLite cannot modify a column; see [SQLite `ALTER TABLE` limitations](../orm-sqlite/04-schema-and-ddl.md#alter-table-limitations). There, SQLite does not enforce the `VARCHAR` length either.

## Important behaviour

- The table always lives on the `default` connection. Moving it means changing `db.DefaultConnection`, which moves every model bound to `default`.
- Rolling back `Mutex_2024_12_03_11_41_00` leaves the table in place: `down()` is empty.
- A lock row stays after `release()`; only `release(options, true)` and `delete()` remove it.
- The model has no `Id` column; `Name` is the key, so `__mutex__.get(name)` finds a lock by name.
- The `__mutex__` constructor takes a required `data` argument. Under `strictNullChecks`, static calls such as `__mutex__.where()` fail to type-check; cast the class as the examples below do. `OrmMutex` itself casts it to `any`.

## Best practices

- Read locks with `__mutex__` for dashboards and diagnostics; take and release them only through `Mutex`, so the owner check applies.
- When you force-release locks, set `Updated_at` in the same update so the next cleanup sees the change.

## Examples

### List the locks held right now

```ts sample
import { ModelBase } from '@spinajs/orm';
import { __mutex__ } from '@spinajs/orm-threading';

// __mutex__ declares a required constructor argument, which the static model API rejects under strictNullChecks.
const MutexTable = __mutex__ as unknown as typeof ModelBase & (new (data?: Partial<__mutex__>) => __mutex__);

export async function heldLocks(): Promise<Array<{ name: string; owner: string; since: string }>> {
  const locks = await MutexTable.where({ Locked: true });

  return locks.map((lock) => ({
    name: lock.Name,
    owner: lock.Tenant,
    since: lock.Updated_at.toISO() ?? '',
  }));
}
```

### Release stale locks

`OrmMutex` locks never expire. A cleanup job frees locks held longer than an hour. It relies on `Updated_at` being stamped at acquire time, which the stock `OrmMutex` does not do; register [`AtomicOrmMutex`](02-custom-mutex-backends.md#ormmutex-atomic-acquire) or another subclass that sets it.

```ts sample
import { DateTime } from 'luxon';
import { ModelBase } from '@spinajs/orm';
import { __mutex__ } from '@spinajs/orm-threading';

// __mutex__ declares a required constructor argument, which the static model API rejects under strictNullChecks.
const MutexTable = __mutex__ as unknown as typeof ModelBase & (new (data?: Partial<__mutex__>) => __mutex__);

export async function releaseStaleLocks(maxAgeMinutes = 60): Promise<number> {
  const cutoff = DateTime.now().minus({ minutes: maxAgeMinutes });

  const result = await MutexTable
    .update({ Locked: false, Updated_at: DateTime.now() })
    .where({ Locked: true })
    .where('Updated_at', '<', cutoff);

  return result.RowsAffected;
}
```

## Related

- [Database mutex](01-database-mutex.md): how `OrmMutex` reads and writes these rows.
- [Custom mutex backends](02-custom-mutex-backends.md): `AtomicOrmMutex`, which stamps `Updated_at`.
- [Models](../orm/02-models.md) and [Model API](../orm/03-model-api.md): `@Model`, `@Primary`, `where()`, `update()`.
- [Migrations](../orm/10-migrations.md): discovery, the boot pass and rollback.
- [Schema builder](../orm/09-schema-builder.md): `alterTable()` and `modify()`.

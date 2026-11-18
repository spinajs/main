# Mutex table and migration

Every `OrmMutex` lock is a row of the `__mutex__` table, read and written through the exported `__mutex__` model. The package ships the migrations that create the table and name its holder column. Use the model to list or clean up locks, and your own migration to change the table.

## How it works

1. Importing `@spinajs/orm-threading` runs two decorators:
   - `@Model('__mutex__')` registers the `__mutex__` class under `__models__`; `@Connection('default')` binds it to the `default` connection.
   - `@Migration('default')` registers `Mutex_2024_12_03_11_41_00` and `MutexHolder_2026_11_16_00_00_00` under `__migrations__`.
2. `Orm.resolve()` finds the migrations through `DiRegistryMigrationSource`; no directory scan is needed.
3. `Orm.resolve()` (`DI.resolve(Orm)`) runs them when the connection has `Migration.OnStartup: true`. Otherwise run them with the ORM migration commands.
4. `Mutex_2024_12_03_11_41_00.up()` creates the table; `MutexHolder_2026_11_16_00_00_00.up()` renames the column the first one created as `Tenant` to `Holder`, keeping the rows. Their `down()` rename it back and drop the table.
5. `Orm` binds the model to the driver stored under `default`, which is the connection named in `db.DefaultConnection`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.DefaultConnection` | `string` | unset | a connection `Name` | The connection stored as `default`; the table and the model live there. |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Runs the pending `__mutex__` migrations when the `Orm` resolves. See [Migrations](../orm/10-migrations.md#configuration). |

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
| `Holder` | `VARCHAR(32)`, not null | Current or last owner. |
| `Locked` | `BOOLEAN`, not null, default `0` | `true` while the owner holds the lock. |
| `LockedUntil` | `BIGINT`, null | Expiry as epoch milliseconds on the database clock. `NULL` never expires. Set by `acquire()` and `renew()`, cleared by `release()`. |
| `Created_at` | `DATETIME`, not null, default current time | Set on insert; `@CreatedAt` on the model. |
| `Updated_at` | `DATETIME`, not null, default current time | `@UpdatedAt` on the model. Set by every `OrmMutex.acquire()` and `release()`, and by an instance `update()`. |

### The `__mutex__` model

| Member | Decorator | Type |
| --- | --- | --- |
| class `__mutex__` | `@Connection('default')`, `@Model('__mutex__')` | `ModelBase<__mutex__>` |
| `Name` | `@Primary()` | `string` |
| `Holder` | none | `string` |
| `Locked` | none | `boolean` |
| `LockedUntil` | none | `number \| null` |
| `Created_at` | `@CreatedAt()` | Luxon `DateTime` |
| `Updated_at` | `@UpdatedAt()` | Luxon `DateTime` |

The constructor fills `Created_at` and `Updated_at` with `DateTime.now()` unless the data passed in sets them.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `__mutex__` model | `__models__` list, registered by `@Model` on import | `__mutex__` | none | Use it directly for reads and admin writes. `OrmMutex` references the class itself, so a subclass model is **not** picked up; change the table with a migration instead. |
| `Mutex_2024_12_03_11_41_00` migration | `__migrations__` list, registered by `@Migration('default')` on import | creates `__mutex__` | none | Add your own later migration on `default` to alter the table. Its `down()` drops the table. |
| `MutexHolder_2026_11_16_00_00_00` migration | `__migrations__` list, registered by `@Migration('default')` on import | renames `__mutex__.Tenant` to `Holder` | none | Runs after the first one. A migration of your own that names the holder column must be dated after it. |

### Migration: widen the name and holder columns

`VARCHAR(32)` is short for task names such as `task-recalculate-warehouse-stock` or holders built from a host name. Add a later migration that widens both columns. The class name's timestamp must be after `2026_11_16_00_00_00`, the migration that renames the holder column.

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('default')
export class WidenMutexColumns_2026_12_01_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Name', 128).notNull().modify();
    });

    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Holder', 128).notNull().modify();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Holder', 32).notNull().modify();
    });

    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Name', 32).notNull().modify();
    });
  }
}
```

Each column gets its own `alterTable()` call, because the statements of one call are sent concurrently. On SQLite each `modify()` rebuilds the table, and the `VARCHAR` length is not enforced; see [SQLite: modifying columns](../orm-sqlite/04-schema-and-ddl.md#modifying-columns).

## Important behaviour

- The table always lives on the `default` connection. Moving it means changing `db.DefaultConnection`, which moves every model bound to `default`.
- Rolling back `Mutex_2024_12_03_11_41_00` drops the `__mutex__` table, and every lock in it.
- A lock row stays after `release()`; only `release(options, true)` and `delete()` remove it.
- A row with `Locked = true` and a `LockedUntil` in the past is free for `acquire()` and `wait()`, though nobody has rewritten it yet.
- The model has no `Id` column; `Name` is the key, so `__mutex__.get(name)` finds a lock by name.

## Best practices

- Read locks with `__mutex__` for dashboards and diagnostics; take and release them only through `Mutex`, so the owner check applies.
- When you force-release locks, set `Updated_at` and clear `LockedUntil` in the same update so the next cleanup sees the change.
- Prefer a `ttl` on the locks themselves over a cleanup job: an expired lock frees itself.

## Examples

### List the locks held right now

```ts sample
import { __mutex__ } from '@spinajs/orm-threading';

export async function heldLocks(): Promise<Array<{ name: string; owner: string; since: string; until: string | null }>> {
  const locks = await __mutex__.where({ Locked: true });

  return locks.map((lock) => ({
    name: lock.Name,
    owner: lock.Holder,
    since: lock.Updated_at.toISO() ?? '',
    until: lock.LockedUntil === null ? null : new Date(Number(lock.LockedUntil)).toISOString(),
  }));
}
```

### Release stale locks

Locks taken with `ttl: 0`, the default, never expire. A cleanup job frees locks held longer than an hour. It relies on `Updated_at`, which `OrmMutex.acquire()` stamps when it takes a lock; `renew()` does not stamp it, so leave locks with a `LockedUntil` to expire on their own.

```ts sample
import { DateTime } from 'luxon';
import { __mutex__ } from '@spinajs/orm-threading';

export async function releaseStaleLocks(maxAgeMinutes = 60): Promise<number> {
  const cutoff = DateTime.now().minus({ minutes: maxAgeMinutes });

  const result = await __mutex__
    .update({ Locked: false, LockedUntil: null, Updated_at: DateTime.now() })
    .where({ Locked: true })
    .whereNull('LockedUntil')
    .where('Updated_at', '<', cutoff);

  return result.RowsAffected;
}
```

## Migration

### `__mutex__.Tenant` is `__mutex__.Holder`

The column and the model property are renamed, with no alias. `MutexHolder_2026_11_16_00_00_00` renames the column and keeps the rows. It runs with `Migration.OnStartup: true` or with the ORM migration commands.

```ts
// Before
const mine = await __mutex__.where({ Tenant: holder, Locked: true });

// After
const mine = await __mutex__.where({ Holder: holder, Locked: true });
```

- Change raw SQL and dashboards that read `__mutex__.Tenant`.
- A migration of your own that names the `Tenant` column must run before `MutexHolder_2026_11_16_00_00_00`, or name `Holder`.
- The rename does not survive a rolling deploy. A replica of the old version fails on the renamed column; a replica of the new version fails until the migration has run. Stop the old replicas, migrate, then start the new ones.

## Related

- [Database mutex](01-database-mutex.md): how `OrmMutex` reads and writes these rows.
- [Custom mutex backends](02-custom-mutex-backends.md): extend `OrmMutex` or replace it.
- [Models](../orm/02-models.md) and [Model API](../orm/03-model-api.md): `@Model`, `@Primary`, `where()`, `update()`.
- [Migrations](../orm/10-migrations.md): discovery, migrating on startup and rollback.
- [Schema builder](../orm/09-schema-builder.md): `alterTable()` and `modify()`.

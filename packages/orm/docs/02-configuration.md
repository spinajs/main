# Configuration

Everything the ORM reads lives under the `db` key of `@spinajs/configuration`.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'main',
        Aliases: {
          'db-user-session': 'main',
        },
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-mysql',
            Host: '127.0.0.1',
            Port: 3306,
            User: 'app',
            Password: 'secret',
            Database: 'app',
            Encoding: 'utf8mb4',
            Pool: { Min: 2, Max: 20, IdleTimeout: 30000, AcquireTimeout: 10000 },
            Resilience: { HealthCheckInterval: 30000, MaxRetries: 5, RetryDelay: 200, MaxRetryDelay: 5000 },
            Migration: {
              OnStartup: true,
              Table: 'spinajs_migration',
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
              Lock: { Enabled: true, Timeout: 30000, StaleAfter: 600000 },
            },
          },
        ],
      },
    });
  }
}
```

## Top-level `db` keys

| Key | Type | Meaning |
| --- | --- | --- |
| `db.Connections` | `IDriverOptions[]` | The connections to open. Defaults to `[]`. |
| `db.DefaultConnection` | `string` | Name of an existing connection that is additionally registered under the name `default`. Throws if the named connection does not exist. |
| `db.Aliases` | `Record<string, string>` | Extra names for existing connections. Each value must name a connection already in the list. |

Aliases exist so a module that hard-codes a connection name (`db-user-session`, say) can be
pointed at a connection you already have rather than forcing a second one open.

## `IDriverOptions`

### Identity

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Name` | `string` | — | Connection name. This is what `@Connection('...')` refers to. |
| `Driver` | `string` | — | DI key the driver class was registered under, e.g. `orm-driver-mysql`. Resolving fails loudly if nothing is registered under it. |
| `Database` | `string` | — | Database / schema name. |
| `User`, `Password`, `Host`, `Port` | | — | Server credentials. |
| `Encoding` | `string` | — | Connection charset. |
| `Filename` | `string` | — | Database file, for file-backed dialects (SQLite). |
| `Options` | `any` | — | Passed through to the underlying driver library untouched. |

`Name`, `Driver`, `Database`, `User`, `Host`, `Port` and `Filename` are the only options echoed
into connection log lines — `Password` is never logged.

### Pooling — `Pool`

| Option | Default | Meaning |
| --- | --- | --- |
| `Min` | `0` | Connections kept open while idle. |
| `Max` | `10` | Maximum concurrent connections. |
| `IdleTimeout` | `30000` | Milliseconds an idle connection is kept before closing. |
| `AcquireTimeout` | `10000` | Milliseconds to wait for a free connection before failing. |

`PoolLimit` is the deprecated predecessor of `Pool.Max` and is still honoured when `Pool.Max` is
absent. Resolution order is `Pool.Max` → `PoolLimit` → `10`.

SQLite treats `Pool.Max` differently: writes always serialize on one handle because SQLite locks
at the file level, so `Max` sizes a pool of `Max - 1` **read-only** handles instead. It is
ignored entirely for `:memory:` and anonymous temporary databases, where each handle would open
its own private database. See [orm-sqlite's docs](../../orm-sqlite/docs/).

### Resilience — `Resilience`

| Option | Default | Meaning |
| --- | --- | --- |
| `HealthCheckInterval` | `30000` | Milliseconds between health probes. `0` disables the probe. |
| `MaxRetries` | `5` | Reconnect attempts after a transport failure. |
| `RetryDelay` | `200` | Base backoff in milliseconds. |
| `MaxRetryDelay` | `5000` | Backoff ceiling. |

Only transport failures are retried. A malformed statement or a constraint violation propagates
on the first attempt. Details in [13-observability.md](13-observability.md).

### Migrations — `Migration`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `OnStartup` | `boolean` | `false` | Run pending migrations when `Orm` resolves. |
| `Table` | `string` | `spinajs_migration` | Table recording applied migrations. Created — or upgraded from the legacy two-column shape — automatically. A `<Table>_lock` companion is created alongside it. |
| `Service` | `string` | — | DI token of an `OrmMigrationService` implementation to use for this connection. Absent means the built-in `DefaultMigrationService`. |
| `Transaction.Mode` | `MigrationTransactionMode` | `None` | `None` runs migrations bare; `PerMigration` wraps each in its own transaction; `PerRun` wraps the whole per-connection run in one. |
| `Lock.Enabled` | `boolean` | `true` | Take the `<Table>_lock` row for the duration of a run. |
| `Lock.Timeout` | `number` | `30000` | Milliseconds to wait for the lock before failing the run. |
| `Lock.StaleAfter` | `number` | `600000` | Milliseconds after which a held lock counts as abandoned and is stolen. |

`OnStartup: false` only suppresses the *automatic* run. An explicit `orm.Migration.up()` passes
`force = true` and runs regardless — that is how the CLI and tests migrate on demand.

`Service` is a **string DI token**, not a class: register your implementation with
`DI.register(MyService).as('my-token')` and put `'my-token'` here. It is resolved from the
connection's own child container, with the driver as its constructor argument.

`Lock.StaleAfter` must sit above your longest migration run. It is judged against the migrating
host's clock, and the lock exists for crash recovery on a single migrating process — concurrent
migration from several processes is out of scope. `PerRun` splits around any migration declaring
`transaction = false`. All of this is covered in
[10-schema-and-migrations.md](10-schema-and-migrations.md).

### SQL dialect details

| Option | Default | Meaning |
| --- | --- | --- |
| `AliasSeparator` | `$` (`#` on MSSQL) | Character wrapping generated table aliases. MSSQL overrides it because `$` starts a pseudo-column there. |
| `DefaultConnection` | `false` | Present on the options interface, but the ORM decides the default connection from the top-level `db.DefaultConnection` string. Setting it per connection has no effect. |

Generated aliases look like `SELECT $users$.Name FROM users as $users$`.

### SSH tunnelling — `SSH`

Only `MySqlSSHOrmDriver` acts on it.

```ts sample
import { IDriverOptions } from '@spinajs/orm';

export const tunnelled: IDriverOptions = {
  Name: 'remote',
  Driver: 'orm-driver-mysql-ssh',
  Host: '127.0.0.1',
  Port: 3306,
  Database: 'app',
  SSH: {
    Host: 'bastion.example.com',
    Port: 22,
    User: 'deploy',
    PrivateKey: '/home/deploy/.ssh/id_rsa',
  },
};
```

## Model and migration discovery

Models and migrations are **not** found by scanning directories from ORM configuration. They
register themselves with DI when their decorator runs:

- `@Model(table)` → `DI.register(target).as('__models__')`
- `@Migration(connection)` → `DI.register(target).as('__migrations__')`

`Orm.resolve()` then reads back `DI.getRegisteredTypes('__models__')` and
`DI.getRegisteredTypes('__migrations__')`. The practical consequence is that **a model file has
to be imported before `Orm` resolves**, or the decorator never runs and the model is invisible.
Applications normally arrange this through `@spinajs/configuration`'s `system.dirs` file
discovery, or by importing an index module.

## What `Orm.resolve()` does, in order

1. `createConnections()` — resolve each driver, `connect()`, store it, start its health check.
   Then register `db.DefaultConnection` under `default` and wire `db.Aliases`. Finally register
   an `OrmConnection` DI factory so any module can fetch a driver by name.
2. Register every `__migrations__` and `__models__` type it finds, and build the `orm.Migration`
   facade (a `MigrationRunner`) over them — which is why `orm.Migration` does not exist on an
   unresolved `Orm`.
3. Register the default value converters (`DateTime`/`Date` → datetime, `Boolean`/`Bool` →
   boolean, `Time`/`TimeSpan` → time) into `__orm_db_value_converters__`. **This precedes the
   migration pass on purpose:** that pass probes the migration tracking table with
   `driver.tableInfo()`, and a driver's `tableInfo()` may read this map. Registering it afterwards
   left the map absent for the whole boot pass and crashed every restart of an already-migrated
   database.
4. `Migration.up(undefined, { force: false })` — apply pending migrations for connections with
   `Migration.OnStartup`.
5. `reloadTableInfo()` — for each model, call `driver.tableInfo()`, merge the reflected columns
   over the decorator-declared ones, attach converters, mark relation foreign keys, and build
   `descriptor.Schema` via `buildModelJsonSchema`.
6. `wireRelations()` — resolve every relation's `TargetModelType` (a class, a forward ref or a
   model *name*) to a concrete class. Throws if a target was never registered.
7. `applyModelMixins()` — bind `MODEL_STATIC_MIXINS` onto every model class. **This is the step
   that makes `User.where(...)` work.**
8. Run the `data()` hook of each migration **step 4 applied**, now that models are usable. Every
   hook runs even when an earlier one throws, and the failures are reported together. This is the
   only place `data()` is called — a migration applied later, through `orm.Migration.up()` or the
   CLI, does not get its `data()` in that process.

## Getting a connection at runtime

```ts sample
import { DI } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';

export async function connections() {
  // By name, through the factory Orm registers during resolve().
  const main = DI.resolve<OrmDriver>('OrmConnection', ['main']);

  // Or straight off the Orm service.
  const orm = DI.get<Orm>('Orm');
  const same = orm?.Connections.get('main');

  return { main, same };
}
```

`DI.resolve('OrmConnection', [name])` returns `null` for an unknown name rather than throwing.

## Multiple connections

A model belongs to exactly one connection, named by `@Connection`. A model with no
`@Connection` has `Connection: null` in its descriptor and will fail to find a driver.

One thing the unit of work enforces: `save()` refuses to persist a graph that spans two
connections, because its transaction only covers one of them. Save each connection's graph
separately.

## Disposal

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function shutdown() {
  const orm = DI.get<Orm>('Orm');
  // Stops every health-check timer and disconnects every connection.
  await orm?.dispose();
}
```

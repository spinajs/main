# Seeding

A migration's `data()` hook is its seed: the rows a table needs once it exists, such as default roles or a system account. `migrate-up` runs the seeds of the migrations it applied. `migrate-seed` runs the seeds of every applied migration again.

```sh
spinajs migrate-up                                              # apply, then seed what was applied
spinajs migrate-up --skip-seed                                  # apply only
spinajs migrate-seed                                            # seed every applied migration
spinajs migrate-seed --name CreateRoles_2026_10_01_09_00_00     # seed one applied migration
spinajs migrate-seed --connection reporting                     # seed one connection's migrations
```

## How it works

### `migrate-up`

`OrmMigrator.migrate()` holds the run lock of every connection it touches, and in that lock:

1. applies every pending `up()`, in global `(timestamp, name)` order across connections;
2. re-reads the table info of the models those migrations touched;
3. runs `data()` of the migrations it applied, in the same order.

Step 3 is skipped with `--skip-seed` (`migrate({ skipSeed: true })`) and with `--fake`, whose migrations never ran `up()`. Every hook runs even when an earlier one throws; the failures are reported together in one `OrmException` (`Migration data() phase failed for: <name> (<reason>), ...`) and the command exits non-zero. The migrations stay applied.

### `migrate-seed`

`MigrateSeedCommand.execute({ name, connection })` calls `OrmMigrator.seed({ name, connection })`:

1. It reads `Runner.status({ connection, readOnly: true })`, without DDL, and keeps the applied migrations, or only `--name`.
2. When none is left, it stops without taking a lock. With `--name`, a name no migration is registered under throws `Migration <name> is not registered - check the name for typos`, and a registered one throws `Migration <name> is not applied on any configured connection - nothing to seed` (`on connection <connection>` with `--connection`). Without `--name`, it logs `Nothing is applied - nothing to seed` at `info` level and exits `0`.
3. It takes the run lock of every connection with registered migrations, or only of `--connection`, or only of the connection `--name` runs on, and reads the status again.
4. It resolves each migration from its connection's container and runs its `data()`, in `(timestamp, name)` order. Every hook runs; the failures are reported together, as in `migrate-up`.
5. It logs `Seeded <n> migration(s): <names>` at `success` level through the `ORM-CLI` logger and releases the locks.

`migrate-seed` never applies a migration and writes no tracking row. When no connection in scope has anything applied, it creates no table; otherwise taking the run lock creates or brings to the current format the tracking and lock tables of each connection it locks, as every run does, also of one with nothing applied. A pending migration is not seeded.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `-n, --name [name]` | `string` | none | Seed only this applied migration, by class name |
| `-c, --connection [connection]` | `string` | none | Seed only the migrations of this connection, by name or alias; only its run lock is taken |

`execute()` takes `IMigrateSeedCommandOptions`: `{ name?: string; connection?: string }`.

`migrate-up --skip-seed` is described in [Applying migrations](01-applying-migrations.md#options).

## Exit codes

| Result | Exit code |
| --- | --- |
| Every seed ran, or nothing is applied yet | `0` |
| `--name` is not registered, or not applied on a configured connection | `-1` (255 on POSIX), the error through the `CLI` logger |
| `--connection` matches no configured connection or alias | `-1` |
| A `data()` hook throws (after every hook ran) | `-1` |
| The run lock cannot be taken within `Migration.Lock.Timeout`, or is lost during the run | `-1` |

## The run lock

Seeds run inside the same run lock as the migrations: one lock per connection, taken in connection-name order and held until the last seed returns. So two `migrate-up` or `migrate-seed` runs against one database never seed at the same time, and a `migrate-up` on another host waits until the seeds are done. Before the seeds start, the migrator checks that no lock was lost (`MigrationLockLostException`). See [Migrations: locking](../orm/10-migrations.md#locking).

## Seeds must be safe to rerun

`migrate-seed` runs a seed again on a database that already holds its rows, and an operator may run it more than once. Write each `data()` so that a rerun changes nothing.

Check before you insert:

```ts sample
import { Connection, Migration, Model, ModelBase, OrmDriver, OrmMigration, Primary } from '@spinajs/orm';

@Connection('default')
@Model('roles')
class Role extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Migration('default')
export class CreateRoles_2026_10_01_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('roles', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').unique();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('roles');
  }

  public async data(): Promise<void> {
    for (const name of ['admin', 'user']) {
      const existing = await Role.where({ Name: name }).first();

      if (!existing) {
        await Role.insert({ Name: name });
      }
    }
  }
}
```

Or let the database decide, on a primary or unique key (the upsert pattern):

```ts sample
import { Connection, InsertBehaviour, Migration, Model, ModelBase, OrmDriver, OrmMigration, Primary } from '@spinajs/orm';

@Connection('default')
@Model('settings')
class Setting extends ModelBase {
  @Primary()
  public Key: string;

  public Value: string;
}

@Migration('default')
export class CreateSettings_2026_10_02_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('settings', (table) => {
      table.string('Key').primaryKey();
      table.string('Value');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('settings');
  }

  public async data(): Promise<void> {
    // a rerun keeps a value an operator changed since
    await Setting.insert({ Key: 'locale', Value: 'en' }, InsertBehaviour.InsertOrIgnore);
  }
}
```

`InsertOrIgnore` keeps a row that exists; `InsertOrUpdate` overwrites it, which suits values the code owns rather than the operator.

## Seeds may use any service

The CLI process resolves the `Orm` before any seed runs. A `data()` hook may therefore resolve any service that injects the `Orm` (`DI.resolve(UserService)`), query models and call other packages' APIs, as application code does.

## Recovering an applied but unseeded migration

The tracking table records `up()`, not `data()`. A migration whose seed never ran stays applied and unseeded:

- a run applied M1 and then failed on M2, so it reached no seed (the run stops at the first failing `up()`);
- a run used `--skip-seed`;
- a seed threw, and its cause is fixed now.

Run `spinajs migrate-seed --name M1`, or `spinajs migrate-seed` to rerun every seed. `migrate-status` cannot show which migrations are unseeded, so prefer the full run when in doubt; seeds are safe to rerun.

## Related

- [Applying migrations](01-applying-migrations.md): `migrate-up`, `--skip-seed` and `--dry-run`.
- [Migrations](../orm/10-migrations.md): `OrmMigrator.seed()`, `OrmMigrator.migrate()`, the run lock and the tracking table.
- [Migration status](03-migration-status.md): what is applied.

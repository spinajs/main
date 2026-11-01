# Applying migrations

`migrate-up` applies pending migrations and their `data()` seeds through `OrmMigrator.migrate()`, which applies and seeds as an application's `Orm.resolve()` does on startup. Use it in a deploy step, or to apply a migration on a connection whose `Migration.OnStartup` is off.

```sh
spinajs migrate-up                                              # everything pending, every connection
spinajs migrate-up --name CreateInvoices_2026_10_01_09_00_00    # exactly one migration
spinajs migrate-up --connection reporting                       # one connection only
spinajs migrate-up --fake                                       # record as applied, run nothing
```

## How it works

1. `MigrateUpCommand.execute(options)` calls [`resolveCliMigrator()`](06-cli-orm.md). The migrator and its `Orm` resolve without applying anything.
2. It calls `migrator.migrate({ name, fake, connection })`. `force` is left at its default `true`, so connections with `Migration.OnStartup: false` run too.
3. `OrmMigrator.Runner` plans, orders and applies the migrations; the migrator then re-reads the table info of the models they touched and runs their `data()` hooks (none with `--fake`). See [Migrations: `OrmMigrator`](../orm/10-migrations.md#ormmigrator). Ordering, batches, locking and transactions are described in [Migrations: a run](../orm/10-migrations.md#a-run-migrationrunnerup). It throws, and the command fails, when:
   - `--name` matches no registered migration (`OrmException`, message contains `not registered`);
   - `--connection` matches no configured connection or alias (`OrmException` naming it);
   - the connection holds a [failed](../orm/10-migrations.md#migration-states) migration;
   - a migration's `up()` throws;
   - a `data()` hook throws (`OrmException` `Migration data() phase failed for: ...`, after every hook ran).
4. `MigrateUpCommand.reportRun(migrator, executed, options)` reports the result. With a non-empty result, it logs `Applied <n> migration(s): <names>` at `success` level, or `Recorded as applied ( --fake, nothing was executed ) ...` with `--fake`.
5. With an empty result and no `--name`, it logs that nothing is pending (naming the connection when `--connection` was given). Exit code `0`.
6. With an empty result and a `--name`, `MigrateUpCommand.explainEmptyNamedRun()` calls `migrator.Runner.status()`, unfiltered, and finds the entry:
   - no entry: the migration is registered, but its connection is not configured here or it has no `@Migration()`. Logs an error, sets `process.exitCode = 1`;
   - applied: logs `already applied ... nothing to do`. Exit code `0`;
   - otherwise: logs a connection mismatch when `--connection` was given, then that the migration is failed or still pending. Sets `process.exitCode = 1`.
7. Without `--name` and `--connection`, `MigrateUpCommand.checkModelTables(orm, fake)` checks the model tables:
   - with [`db.StrictTableCheck`](../orm/01-connections.md#configuration) `false`, it returns at once: the `Orm` resolve already logged each missing table as a warning;
   - otherwise it calls `orm.reloadTableInfo({ strict: true })`. A registered model whose table is still missing makes it log `Migrations are applied, but the application will not boot: Missing tables (db.StrictTableCheck): ...` at error level (`Migrations are recorded as applied ( --fake ), but ...` with `--fake`) and set `process.exitCode = 1`. The migrations stay applied;
   - any other error from `reloadTableInfo()` is rethrown, and the command fails.

```mermaid
sequenceDiagram
  participant Op as spinajs migrate-up
  participant Cmd as MigrateUpCommand
  participant DI
  participant Mg as OrmMigrator
  participant R as OrmMigrator.Runner
  Op->>Cmd: execute({ name, connection, fake })
  Cmd->>DI: resolveCliMigrator()  (MigrateOnStartup: false)
  DI-->>Cmd: OrmMigrator (its Orm resolved)
  Cmd->>Mg: migrate({ name, fake, connection })
  Mg->>R: up(name, options)
  Mg->>Mg: reloadTableInfo(touched), data() unless --fake
  Mg-->>Cmd: OrmMigration[]
  alt empty result and --name
    Cmd->>R: status()
    Cmd->>Cmd: explainEmptyNamedRun() -> exitCode 1 unless applied
  end
  opt no --name and no --connection
    Cmd->>Cmd: checkModelTables() -> exitCode 1 when a model has no table (db.StrictTableCheck)
  end
```

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `-n, --name [name]` | `string` | none | Apply only this migration, by class name (`<Prefix>_yyyy_MM_dd_HH_mm_ss`) |
| `-c, --connection [connection]` | `string` | none | Apply only on this connection, by name or alias. Other connections are not touched; their tracking tables are not even created |
| `-f, --fake` | `boolean` | `false` | Write the tracking rows as applied without calling `up()` or `data()` |

`execute()` takes `IMigrateUpCommandOptions`: `{ name?: string; connection?: string; fake?: boolean }`.

## Exit codes

| Result | Exit code |
| --- | --- |
| Migrations applied, or nothing pending | `0` |
| `--name` given and the migration is already applied | `0` |
| `--name` given and the migration did not run (connection not configured, excluded by `--connection`, failed or still pending) | `1` |
| A full run (no `--name`, no `--connection`) leaves a registered model without its table, with `db.StrictTableCheck` on | `1` |
| Unknown `--name`, unknown `--connection`, a failed row on the connection, a migration or a `data()` hook that throws, a table check that fails for another reason than a missing table | `-1` (255 on POSIX), the error through the `CLI` logger |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateUpCommand` | Class token `MigrateUpCommand`, singleton (no lifetime decorator); `@Command` also registers it under `'__cli_command__'`. `Cli` resolves it lazily, only when `migrate-up` is invoked | `MigrateUpCommand` | none shipped | `DI.register(MySub).as(MigrateUpCommand)` before `Cli` dispatches; override `execute()`, `reportRun()`, `explainEmptyNamedRun()` or `checkModelTables()`. See [Customizing commands](08-customizing-commands.md) |
| Migration service per connection | `db.Connections[].Migration.Service` (a DI token), resolved by the runner | `DefaultMigrationService` from `@spinajs/orm` | none shipped | Owned by `@spinajs/orm`; see [Migrations: services](../orm/10-migrations.md#services-and-extension-points). `migrate-up` uses whatever service the connection configures |

### `MigrateUpCommand`: refuse to migrate production without a confirmation

`execute()` runs the migrations and calls the hooks: `reportRun(migrator, executed, options)` logs the result, `explainEmptyNamedRun(migrator, name, connection?)` decides how an empty named run is reported, and `checkModelTables(orm, fake?)` checks the tables after a full run. This subclass adds a guard before the shipped behaviour.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IMigrateUpCommandOptions, MigrateUpCommand } from '@spinajs/orm-cli';

/** `migrate-up` that runs against production only when MIGRATE_CONFIRM=yes is set. */
export class ConfirmedMigrateUpCommand extends MigrateUpCommand {
  public async execute(options: IMigrateUpCommandOptions): Promise<void> {
    const production = (process.env.APP_ENV ?? 'production').startsWith('prod');

    if (production && !options.fake && process.env.MIGRATE_CONFIRM !== 'yes') {
      throw new InvalidArgument('Refusing to migrate production: set MIGRATE_CONFIRM=yes to apply, or pass --fake to only record');
    }

    await super.execute(options);
  }
}

// In your own CLI entry point, before `DI.resolve(Cli)`:
DI.register(ConfirmedMigrateUpCommand).as(MigrateUpCommand);
```

Keep the subclass out of every `system.dirs.cli` directory: it inherits the `migrate-up` metadata and would be added as a second `migrate-up` command.

## Important behaviour

- **The migrator applies nothing on its way in.** Without `resolveCliMigrator()`, the `Orm`'s resolve would apply every pending migration on `OnStartup` connections before `--fake` could take effect. See [The CLI migrator](06-cli-orm.md).
- **`migrate-up` seeds what it applied.** `data()` runs once every migration of the run is applied; it may resolve services that inject the `Orm`. A run that fails on a migration seeds none of the ones it applied before it, and a later run finds them applied.
- **An unknown `--name` or `--connection` throws.** An empty, successful-looking run from a typo would read as "already current".
- **A named migration on an unconfigured connection exits `1`.** The runner only warns and returns `[]` there; the command checks `status()` to tell that apart from "already applied".
- **`status()` in step 6 is not narrowed by `--connection`.** A migration on a connection the filter excluded still has an entry, so the command can say which connection it belongs to.
- **`--connection` matches aliases.** The error message states the mismatch as a possibility, because the requested name and the reported connection can be two names for one driver.
- **Only a full run checks the tables.** A run narrowed by `--name` or `--connection` left other migrations out, so it says nothing about their tables and never exits `1` for a missing one.
- **A missing table does not undo the run.** `migrate-up` exits `1` after the migrations are applied (or recorded with `--fake`); fix the cause and run it again, or let the next boot name the table.
- **A failed migration blocks the whole connection.** `migrate-up` throws until [`migrate-resolve`](04-resolving-failed-migrations.md) records its outcome.
- **An interrupted migration does not block.** The next `migrate-up` re-runs it from the top, with a warning from the migration service. Check [`migrate-status`](03-migration-status.md) first.
- **The blocking guarantee is best effort.** When the ORM fails to write the failure row too (dropped connection, locked table), it logs that error instead of raising it. The row then reads as `INTERRUPTED`, and the next `migrate-up` re-runs the migration instead of refusing. After an incident, check `migrate-status` instead of trusting a later successful run.

## Best practices

- Run `migrate-status` before `migrate-up` in a deploy, and stop on a `FAILED` or `INTERRUPTED` line.
- Use `--fake` only to bring the tracking table in line with a database changed by hand; it calls neither `up()` nor `data()`.
- Write `data()` hooks so a rerun is harmless: a deploy that retries `migrate-up` after a seed failure does not run them again, and an operator runs them by hand.
- Pass `--name` together with `--connection` only when you know the migration's connection; otherwise leave `--connection` out.
- Run the deploy step's `migrate-up` without `--name` and `--connection`, so a model left without its table fails the deploy instead of the first start.

## Patterns and antipatterns

```ts
// Don't: DI.resolve(Orm) applies the startup migrations, so pending migrations on OnStartup connections are
// applied (and data() seeded) on its way in, and the explicit run below applies nothing
const orm = await DI.resolve(Orm);
await orm.Migrator.migrate();

// Do: resolve the CLI migrator, then run exactly the migrations you asked for
const migrator = await resolveCliMigrator();
await migrator.migrate({ connection: 'reporting' });
```

## Examples

### Apply one connection from a maintenance script

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MigrateUpCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Applies pending migrations on the reporting replica only, during its maintenance window. */
async function migrateReporting(): Promise<void> {
  await DI.resolve(Configuration);

  const up = await DI.resolve(MigrateUpCommand);
  await up.execute({ connection: 'reporting' });

  // a run narrowed by connection skips the table check; errors have already thrown
  process.exit(process.exitCode ?? 0);
}

void migrateReporting();
```

## Related

- [Migrations](../orm/10-migrations.md): what `OrmMigrator.migrate()` and `MigrationRunner.up()` do, the tracking table and the lock.
- [Rolling back migrations](02-rolling-back-migrations.md): the reverse operation.
- [Migration status](03-migration-status.md): check the result.
- [The CLI migrator](06-cli-orm.md): why the command resolves the migrator without its startup migrations.

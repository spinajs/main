# The CLI migrator

`resolveCliMigrator()` returns the `OrmMigrator` every migration command runs against, resolved without its boot pass. Resolving it resolves the `Orm` it injects: connections, models, value converters and table info. Nothing is applied on the way in. Use it in your own commands and scripts that inspect or repair migrations.

```ts
import { resolveCliMigrator } from '@spinajs/orm-cli';

const migrator = await resolveCliMigrator(); // DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }])
const entries = await migrator.Runner.status();
```

## How it works

1. `resolveCliMigrator()` calls `DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }])`.
2. `OrmMigrator.resolve()` resolves the `Orm` as a migration tool. `Orm.resolve()` never migrates and skips its `db.StrictTableCheck` check, so a fresh database without tables boots. See [Connections](../orm/01-connections.md).
3. `OrmMigrator.resolve()` assigns `Runner` and opens the model-query gate of every `Migration.OnStartup` connection. It sees `MigrateOnStartup: false` and skips the boot pass, its `data()` phase and its `db.StrictTableCheck` check. See [Migrations: the boot pass](../orm/10-migrations.md#the-boot-pass-diresolveormmigrator).
4. When an `OrmMigrator` was already resolved in this process, DI returns that singleton and ignores the options.

Without the option, the boot pass is a trap for a migration tool:

- A connection holding a **failed** migration refuses every migration run, so the resolve throws before the command starts. That would block `migrate-resolve`, the one command that clears the row.
- `migrate-status` would apply everything pending and only then report, so the deploy gate would make the database current, answer "yes" and exit `0`.
- `migrate-up --fake` would really apply the migrations the flag promises only to record.
- `migrate-down` would roll back the batch the boot pass had just created.

## Configuration

`resolveCliMigrator()` reads no configuration of its own. The `Orm` reads the usual `db.*` keys; see [Connections](../orm/01-connections.md#configuration).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `IOrmMigratorOptions.MigrateOnStartup` (constructor argument, not a config key) | `boolean` | `true` (when absent) | `true`, `false` | `false` skips the boot pass. `resolveCliMigrator()` passes `false` |

Nothing changes for an application that resolves `OrmMigrator` the ordinary way.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OrmMigrator` (as resolved by `resolveCliMigrator()`) | Class token `OrmMigrator`, singleton. Constructed with `[{ MigrateOnStartup: false }]` when the CLI resolves it first | `OrmMigrator` from `@spinajs/orm` | none | Resolve your own `OrmMigrator` first; the commands then reuse it |
| `Orm` | Class token `Orm`, singleton, injected by `OrmMigrator` | `Orm` from `@spinajs/orm` | A subclass you register as `Orm` | `DI.register(MyOrm).as(Orm)` before the first resolve |
| `resolveCliMigrator()` | Plain exported function, not a DI service | `DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }])` | none | Not replaceable: the commands import it directly. Call it from your own commands |
| `OrmMigrator.Runner` | `MigrationRunner` created in `OrmMigrator.resolve()` | `MigrationRunner` | none | Owned by `@spinajs/orm`. Per-connection behaviour is replaced through `db.Connections[].Migration.Service`; see [Migrations: services](../orm/10-migrations.md#services-and-extension-points) |

### `Orm`: a subclass the commands pick up

`OrmMigrator` injects the `Orm` token, so a registered subclass is what the commands run against.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/** Logs which connections every Orm in this process opened, CLI or application alike. */
export class InventoryOrm extends Orm {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Log.info(`Orm ready, connections: ${[...this.Connections.keys()].join(', ')}`);
  }
}

// Before anything resolves Orm, eg. at the top of your CLI entry point:
DI.register(InventoryOrm).as(Orm);
```

### Write a new command on the CLI migrator

See [Customizing commands](08-customizing-commands.md#write-a-new-command-on-the-cli-migrator) for a complete command that uses `resolveCliMigrator()`.

## Important behaviour

- **A migrator resolved earlier wins.** In a process that already called `DI.resolve(OrmMigrator)`, the commands get that instance and the option is ignored. Its boot pass has already run whatever its configuration asked for.
- **`migrate-up` seeds.** It runs `OrmMigrator.migrate()`, which calls `data()` of every migration it applied, as an application's boot pass does. `--fake` seeds nothing.
- **Everything else still resolves.** Connections are opened, so a configuration or network error still fails the command. `migrate-create` is the only command that resolves nothing.
- **`MigrateOnStartup: false` is not `force`.** `force` chooses whether `Migration.OnStartup` is honoured, and both its values run migrations. Only `MigrateOnStartup: false` runs none.
- **The table check moves to `migrate-up`.** The CLI boots on a database without tables; a full `migrate-up` then fails with exit code `1` when a registered model still has no table, which is what the application's boot pass would do next.

## Best practices

- Call `resolveCliMigrator()`, not `DI.resolve(OrmMigrator)`, in any tool that reports on or repairs migrations.
- Register an `Orm` subclass before the first resolve; registering it later has no effect on the cached singleton.

## Patterns and antipatterns

```ts
// Don't: the boot pass migrates the database, and fails outright on a connection with a failed row
const migrator = await DI.resolve(OrmMigrator);
const entries = await migrator.Runner.status();

// Do
const migrator = await resolveCliMigrator();
const entries = await migrator.Runner.status();
```

## Examples

### Fail a health check on checksum drift

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { resolveCliMigrator } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Exits 1 when an applied migration's source changed after it ran. Applies nothing. */
async function checkDrift(): Promise<void> {
  await DI.resolve(Configuration);

  const migrator = await resolveCliMigrator();
  const drifted = (await migrator.Runner.status()).filter((e) => e.applied && e.checksumMismatch);

  for (const e of drifted) {
    console.log(`${e.connection}\t${e.name}\tedited after it was applied`);
  }

  await (await DI.resolve(Orm)).dispose();
  process.exit(drifted.length > 0 ? 1 : 0);
}

void checkDrift();
```

## Migration

`resolveCliOrm()` and `CLI_ORM_OPTIONS` are removed: `Orm.resolve()` no longer migrates, and the runner lives on `OrmMigrator`.

```ts
// Before
const orm = await resolveCliOrm();
const entries = await orm.Migration.status();

// After
const migrator = await resolveCliMigrator();
const entries = await migrator.Runner.status();
```

## Related

- [Migrations: `OrmMigrator`](../orm/10-migrations.md#ormmigrator): the options and members of the migrator.
- [Migrations: the boot pass](../orm/10-migrations.md#the-boot-pass-diresolveormmigrator): what `MigrateOnStartup: false` skips.
- [Customizing commands](08-customizing-commands.md): building your own commands on this migrator.

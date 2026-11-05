# The CLI migrator

`resolveCliMigrator()` returns the `OrmMigrator` every migration command runs against, together with its `Orm`: connections, models, value converters and table info. It boots in tool mode: the boot check that an application's `Orm.resolve()` runs is disabled, so the commands work on a database with pending or failed migrations, and nothing is applied on the way in. Use it in your own commands and scripts that inspect or repair migrations.

```ts
import { resolveCliMigrator } from '@spinajs/orm-cli';

const migrator = await resolveCliMigrator(); // resolveMigrationTool() from @spinajs/orm
const entries = await migrator.Runner.status();
```

## How it works

1. `resolveCliMigrator()` calls `resolveMigrationTool()` from `@spinajs/orm`, in `DI.RootContainer`.
2. `resolveMigrationTool()` resolves `OrmMigrationGuard` with `[{ Enabled: false }]`. The guard is one per container, so the `Orm` resolved next in that container gets this disabled one.
3. It resolves the `Orm`. `Orm.resolve()` sees the guard disabled and runs no boot check, so no `PendingMigrationsException` and no `Migration.OnStartup` refusal. It reads table info, logs each missing table as a warning and skips its `db.StrictTableCheck` check, so a fresh database without tables boots. See [Migrations: boot check](../orm/10-migrations.md#boot-check-diresolveorm).
4. It resolves `OrmMigrator` with `[orm]` and returns it. A cached `OrmMigrator` that runs over another `Orm` (the `Orm` was uncached alone) is refused with `OrmException` (`The cached OrmMigrator runs over an Orm that is no longer cached: uncache Orm and OrmMigrator together ( or DI.clearCache() ) ...`).

Without tool mode, the application's boot check would stop every command:

- A pending migration fails the boot with `PendingMigrationsException`, so `migrate-up` could never start, and `migrate-status` could not report what is pending.
- A **failed** migration fails it too, which would block `migrate-resolve`, the one command that clears the row.
- A configuration that still sets `Migration.OnStartup` fails it as well. In tool mode the key is not read, so `migrate-up` still runs on a configuration written for 3.0; the application's boot then names the key.

## Configuration

`resolveCliMigrator()` reads no configuration of its own. The `Orm` reads the usual `db.*` keys; see [Connections](../orm/01-connections.md#configuration). `db.MigrationCheck` and `Migration.Check` do not apply in tool mode: the guard is disabled whatever they say.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OrmMigrationGuard` (as resolved by `resolveMigrationTool()`) | Class token `OrmMigrationGuard`, one per DI container (`@PerChildInstance()`). Constructed with `[{ Enabled: false }]` when the tool resolves it first | `OrmMigrationGuard` from `@spinajs/orm` | none | Not replaced. A guard already cached in the container keeps its options |
| `OrmMigrator` | Class token `OrmMigrator`, singleton. Constructed with `[orm]` by `resolveMigrationTool()` | `OrmMigrator` from `@spinajs/orm` | none | Not replaced |
| `Orm` | Class token `Orm`, singleton, resolved by `resolveMigrationTool()` | `Orm` from `@spinajs/orm` | A subclass you register as `Orm` | `DI.register(MyOrm).as(Orm)` before the first resolve |
| `resolveCliMigrator()` | Plain exported function, not a DI service | `resolveMigrationTool()` | none | Not replaceable: the commands import it directly. Call it from your own commands |
| `OrmMigrator.Runner` | `MigrationRunner` created in the `OrmMigrator` constructor | `MigrationRunner` | none | Owned by `@spinajs/orm`. Per-connection behaviour is replaced through `db.Connections[].Migration.Service`; see [Migrations: services](../orm/10-migrations.md#services-and-extension-points) |

### `Orm`: a subclass the commands pick up

`resolveMigrationTool()` resolves the `Orm` token, so a registered subclass is what the commands run against.

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

- **An application `Orm` resolved earlier is refused.** In a process whose root container already booted the `Orm` as an application, `resolveMigrationTool()` finds the enabled guard that boot cached and throws `OrmException` (`resolveMigrationTool() needs the boot guard disabled ...`). An application boot that failed caches neither the `Orm` nor the guard, so the commands still run after it.
- **Only the migration commands boot in tool mode.** The CLI commands of other packages that open the database (`@spinajs/authn-keys`, `authn-local`, `authn-orm`, `authn-token`, `authn-totp`, `authz-orm`, `authz-rbac`, `scheduler`, `upload`, `users`) inject the `Orm` and boot it as an application does, so they refuse to run on a database with pending migrations. Run `migrate-up` first.
- **`migrate-up` seeds.** It runs `OrmMigrator.migrate()`, which calls `data()` of every migration it applied. `--fake` and `--skip-seed` seed nothing.
- **Everything else still resolves.** Connections are opened, so a configuration or network error still fails the command. `migrate-create` is the only command that resolves nothing.
- **The table check moves to `migrate-up`.** The CLI boots on a database without tables; a full `migrate-up` then fails with exit code `1` when a registered model still has no table, which is what the application's `Orm.resolve()` would do next.

## Best practices

- Call `resolveCliMigrator()` (or `resolveMigrationTool()`), not `DI.resolve(Orm)`, in any tool that reports on or repairs migrations, and call it before anything else resolves the `Orm`.
- Register an `Orm` subclass before the first resolve; registering it later has no effect on the cached singleton.

## Patterns and antipatterns

```ts
// Don't: an ordinary resolve runs the boot check, so it fails on exactly the database you want to inspect
const orm = await DI.resolve(Orm); // PendingMigrationsException while anything is pending or failed

// Do
const migrator = await resolveCliMigrator();
const entries = await migrator.Runner.status({ readOnly: true });
```

## Examples

### Fail a health check on checksum drift

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { resolveCliMigrator } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Exits 1 when an applied migration's source changed after it ran. Applies nothing. */
async function checkDrift(): Promise<void> {
  await DI.resolve(Configuration);

  const migrator = await resolveCliMigrator();
  const drifted = (await migrator.Runner.status({ readOnly: true })).filter((e) => e.applied && e.checksumMismatch);

  for (const e of drifted) {
    console.log(`${e.connection}\t${e.name}\tedited after it was applied`);
  }

  await migrator.Orm.dispose();
  process.exit(drifted.length > 0 ? 1 : 0);
}

void checkDrift();
```

## Migration

### 3.1.0: tool mode is the disabled boot guard

`IOrmMigratorOptions` and `MigrateOnStartup` are removed, and so is `OrmMigrator.boot()`: the `Orm` never migrates, and `resolveMigrationTool()` now boots it with the boot guard disabled. `resolveCliMigrator()` is unchanged for callers.

```ts
// Before (3.0.x); in 3.1.0 this throws an OrmException naming resolveMigrationTool()
const tool = await DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);

// After
const tool = await resolveCliMigrator(); // or resolveMigrationTool() from @spinajs/orm
```

### `resolveCliOrm()` is removed (3.0.x, history)

`resolveCliOrm()` and `CLI_ORM_OPTIONS` are removed: the runner lives on `OrmMigrator`. `resolveCliMigrator()` calls `resolveMigrationTool()`.

```ts
// Before
const orm = await resolveCliOrm();
const entries = await orm.Migration.status();

// After
const migrator = await resolveCliMigrator();
const entries = await migrator.Runner.status();
```

## Related

- [Migrations: `OrmMigrator`](../orm/10-migrations.md#ormmigrator): the members of the migrator and `resolveMigrationTool()`.
- [Migrations: boot check](../orm/10-migrations.md#boot-check-diresolveorm): what tool mode skips.
- [Customizing commands](08-customizing-commands.md): building your own commands on this migrator.

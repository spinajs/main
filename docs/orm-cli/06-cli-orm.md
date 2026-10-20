# The CLI `Orm`

`resolveCliOrm()` returns the `Orm` every migration command runs against: fully resolved (connections, models, value converters, `orm.Migration`) but with the boot migration pass switched off. Use it in your own commands and scripts that inspect or repair migrations.

```ts
import { CLI_ORM_OPTIONS, resolveCliOrm } from '@spinajs/orm-cli';

CLI_ORM_OPTIONS; // { MigrateOnStartup: false }
const orm = await resolveCliOrm(); // DI.resolve(Orm, [CLI_ORM_OPTIONS])
```

## How it works

1. `resolveCliOrm()` calls `DI.resolve(Orm, [CLI_ORM_OPTIONS])`.
2. When no `Orm` exists yet, DI constructs one with `CLI_ORM_OPTIONS` as its `IOrmOptions` and runs `Orm.resolve()`.
3. `Orm.resolve()` creates the connections, discovers migrations and assigns `orm.Migration`. It sees `MigrateOnStartup: false` and skips the boot pass (`orm.Migration.up(undefined, { force: false })`) and with it the `data()` phase. See [Migrations: the boot pass](../orm/10-migrations.md#the-boot-pass). It also reads the models' tables leniently: a missing table is a warning, not the `db.StrictTableCheck` error, since on a fresh database the commands run before the migrations created the tables. `migrate-up` applies the check after a full run.
4. When an `Orm` was already resolved in this process, DI returns that singleton and ignores the options.

Without step 3, an ordinary `DI.resolve(Orm)` is a trap for a migration tool:

- A connection holding a **failed** migration refuses every migration run, so the resolve throws before the command starts. That would block `migrate-resolve`, the one command that clears the row.
- `migrate-status` would apply everything pending and only then report, so the deploy gate would make the database current, answer "yes" and exit `0`.
- `migrate-up --fake` would really apply the migrations the flag promises only to record.
- `migrate-down` would roll back the batch the boot pass had just created.

## Configuration

`resolveCliOrm()` reads no configuration of its own. The `Orm` it returns reads the usual `db.*` keys; see [Connections](../orm/01-connections.md#configuration).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `IOrmOptions.MigrateOnStartup` (constructor argument, not a config key) | `boolean` | `true` (when absent) | `true`, `false` | `false` skips the boot migration pass. `CLI_ORM_OPTIONS` sets it to `false` |

The suppression is opt-in. Nothing changes for an application that resolves its `Orm` the ordinary way, and this package ships no configuration that turns startup migrations off.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Orm` (as resolved by `resolveCliOrm()`) | Class token `Orm`, singleton. Constructed with `[CLI_ORM_OPTIONS]` when the CLI resolves it first | `Orm` from `@spinajs/orm` | A subclass you register as `Orm` | `DI.register(MyOrm).as(Orm)` before the first resolve; `MyOrm` receives `CLI_ORM_OPTIONS` as its constructor argument. Or resolve your own `Orm` first; the commands then reuse it |
| `resolveCliOrm()` | Plain exported function, not a DI service | `DI.resolve(Orm, [CLI_ORM_OPTIONS])` | none | Not replaceable: the commands import it directly. Call it from your own commands to get the same safe `Orm` |
| `orm.Migration` | Property of the resolved `Orm`, a `MigrationRunner` created in `Orm.resolve()` | `MigrationRunner` | none | Owned by `@spinajs/orm`. Per-connection behaviour is replaced through `db.Connections[].Migration.Service`; see [Migrations: services](../orm/10-migrations.md#services-and-extension-points) |

### `Orm`: a subclass the commands pick up

Every command resolves the `Orm` token, so a registered subclass is what they run against. Accept the options argument and pass it on, or the boot pass comes back.

```ts sample
import { DI } from '@spinajs/di';
import { IOrmOptions, Orm } from '@spinajs/orm';

/** Logs which connections every Orm in this process opened, CLI or application alike. */
export class InventoryOrm extends Orm {
  constructor(options: IOrmOptions = {}) {
    super(options);
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    this.Log.info(`Orm ready, connections: ${[...this.Connections.keys()].join(', ')}, migrate on startup: ${this.Options.MigrateOnStartup !== false}`);
  }
}

// Before anything resolves Orm, eg. at the top of your CLI entry point:
DI.register(InventoryOrm).as(Orm);
```

### Write a new command on the CLI `Orm`

See [Customizing commands](08-customizing-commands.md#write-a-new-command-on-the-cli-orm) for a complete command that uses `resolveCliOrm()`.

## Important behaviour

- **An `Orm` resolved earlier wins.** In a process that already called `DI.resolve(Orm)`, the commands get that instance and `CLI_ORM_OPTIONS` is ignored. Its boot pass has already run whatever its configuration asked for.
- **No boot pass means no `data()` hooks.** A migration applied through the CLI `Orm` is never seeded; a later application boot finds it applied and seeds nothing.
- **Everything else still resolves.** Connections are opened, so a configuration or network error still fails the command. `migrate-create` is the only command that resolves no `Orm`.
- **`MigrateOnStartup: false` is not `force`.** `force` chooses whether `Migration.OnStartup` is honoured, and both its values run migrations. Only `MigrateOnStartup: false` runs none.
- **The table check moves to `migrate-up`.** The CLI `Orm` boots on a database without tables; a full `migrate-up` then fails with exit code `1` when a registered model still has no table, which is what the application boot would do next.

## Best practices

- Call `resolveCliOrm()`, not `DI.resolve(Orm)`, in any tool that reports on or repairs migrations.
- Register an `Orm` subclass before the first resolve; registering it later has no effect on the cached singleton.

## Patterns and antipatterns

```ts
// Don't: the boot pass migrates the database, and fails outright on a connection with a failed row
const orm = await DI.resolve(Orm);
const entries = await orm.Migration.status();

// Do
const orm = await resolveCliOrm();
const entries = await orm.Migration.status();
```

## Examples

### Fail a health check on checksum drift

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { resolveCliOrm } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Exits 1 when an applied migration's source changed after it ran. Applies nothing. */
async function checkDrift(): Promise<void> {
  await DI.resolve(Configuration);

  const orm = await resolveCliOrm();
  const drifted = (await orm.Migration.status()).filter((e) => e.applied && e.checksumMismatch);

  for (const e of drifted) {
    console.log(`${e.connection}\t${e.name}\tedited after it was applied`);
  }

  await orm.dispose();
  process.exit(drifted.length > 0 ? 1 : 0);
}

void checkDrift();
```

## Related

- [Connections: `IOrmOptions`](../orm/01-connections.md#iormoptions): the options the `Orm` constructor takes.
- [Migrations: the boot pass](../orm/10-migrations.md#the-boot-pass): what `MigrateOnStartup: false` skips.
- [Customizing commands](08-customizing-commands.md): building your own commands on this `Orm`.

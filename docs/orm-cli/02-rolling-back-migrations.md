# Rolling back migrations

`migrate-down` reverses applied migrations through `OrmMigrator.Runner.down()`. By default it reverses **the last applied batch only**, which is one `migrate-up` run, not the whole history.

```sh
spinajs migrate-down                                            # the last applied batch
spinajs migrate-down --all                                      # every applied migration, every connection
spinajs migrate-down --name CreateInvoices_2026_10_01_09_00_00  # one migration
spinajs migrate-down --connection reporting --all               # everything, on one connection
spinajs migrate-down --fake                                     # drop the tracking rows, run no down()
```

## How it works

1. `MigrateDownCommand.execute(options)` calls [`resolveCliMigrator()`](06-cli-orm.md). Without it, the `Orm`'s resolve would apply pending migrations and this command would then roll back the batch it had just created.
2. `MigrateDownCommand.announce(options)` logs the scope before anything changes:
   - `--connection`: `Limited to connection <name> - no other configured connection is touched`, always first;
   - `--name`: a `warn` that the migration service may report other rows as having no registered class, and that those rows are fine (see [Important behaviour](#important-behaviour));
   - `--all`: a `warn`, `Rolling back EVERY applied migration on every configured connection ( --all )`, or `... on connection <name> ( --all )` when `--connection` is given;
   - otherwise: `Rolling back the LAST APPLIED BATCH only - pass --all to reverse every applied migration`.
3. It calls `migrator.Runner.down(options.name, { all, fake, connection })`. The runner rolls back each connection in turn, newest first; see [Migrations: rollback](../orm/10-migrations.md#rollback-migrationrunnerdown).
4. On success it logs `Rolled back <n> migration(s): <names>`, or `Recorded as rolled back ( --fake, nothing was executed ) ...`.
5. With nothing rolled back, it logs which migration or connection had nothing applied. Exit code `0`.

The runner throws, and the command fails with exit code `-1`, on an unknown `--name` or `--connection`, or when a migration's `down()` throws.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `-n, --name [name]` | `string` | none | Roll back only this migration, by class name |
| `-c, --connection [connection]` | `string` | none | Roll back only on this connection, by name or alias. Narrows `--all` and the default batch scope alike |
| `-a, --all` | `boolean` | `false` | Roll back every applied migration instead of the last batch |
| `-f, --fake` | `boolean` | `false` | Delete the tracking rows without calling `down()` |

`execute()` takes `IMigrateDownCommandOptions`: `{ name?: string; all?: boolean; fake?: boolean; connection?: string }`.

## Exit codes

| Result | Exit code |
| --- | --- |
| Rollback completed, or nothing to roll back | `0` |
| Unknown `--name` or `--connection`, a `down()` that throws | `-1` (255 on POSIX) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateDownCommand` | Class token `MigrateDownCommand`, singleton; also under `'__cli_command__'`. Resolved lazily by `Cli` when `migrate-down` runs | `MigrateDownCommand` | none shipped | `DI.register(MySub).as(MigrateDownCommand)`; override `announce(options)` to change or veto the scope before the rollback, or `execute()`. See [Customizing commands](08-customizing-commands.md) |

### `MigrateDownCommand`: veto a full rollback in production

`announce()` runs after the `Orm` is resolved and before `down()`. Throwing from it stops the rollback with nothing changed.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IMigrateDownCommandOptions, MigrateDownCommand } from '@spinajs/orm-cli';

/** `migrate-down --all` is refused in production unless it is limited to one connection. */
export class GuardedMigrateDownCommand extends MigrateDownCommand {
  protected announce(options: IMigrateDownCommandOptions): void {
    const production = (process.env.APP_ENV ?? 'production').startsWith('prod');

    if (production && options.all && !options.connection) {
      throw new InvalidArgument('migrate-down --all on every connection is disabled in production; pass --connection <name>');
    }

    super.announce(options);
  }
}

// In your own CLI entry point, before `DI.resolve(Cli)`:
DI.register(GuardedMigrateDownCommand).as(MigrateDownCommand);
```

## Important behaviour

- **The default is the last batch.** A short `Rolled back 1 migration(s)` is not a full teardown. Pass `--all` for that.
- **A rollback deletes the tracking row.** It does not stamp it rolled back: the table holds only migrations present in the database. The next `migrate-up` applies the migration again.
- **Failed rows do not block a rollback.** The migration service warns that they stay blocking afterwards. Clear them with [`migrate-resolve`](04-resolving-failed-migrations.md).
- **`--name` produces false orphan warnings.** The runner hands the migration service a one-element list, so every other applied row in the target batch looks unmatched and is warned about as having no registered class (file deleted or renamed). Those rows are healthy. Do not delete them, which is what the warning suggests.
- **`--fake` calls no `down()`.** Use it to align the tracking table with a schema changed by hand.
- **An empty `down()` reports success.** The command cannot tell a no-op `down()` from a real one. Leave `down()` empty only for a change that cannot be reversed.

## Best practices

- Run `migrate-status` first, and roll back with `--name` when only one migration is wrong.
- Pair `--all` with `--connection` in shared environments.
- Write `down()` against the `OrmDriver` argument, the same way as `up()`; models are not wired during a CLI run.

## Patterns and antipatterns

```ts
// Don't: assumes `migrate-down` reverts everything before re-seeding a test database
await (await DI.resolve(MigrateDownCommand)).execute({});

// Do: say what you mean
await (await DI.resolve(MigrateDownCommand)).execute({ all: true, connection: 'test' });
```

## Examples

### Reset a test database between integration runs

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MigrateDownCommand, MigrateUpCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Drops and re-applies every migration on the `test` connection, leaving other connections alone. */
export async function resetTestDatabase(): Promise<void> {
  await DI.resolve(Configuration);

  await (await DI.resolve(MigrateDownCommand)).execute({ all: true, connection: 'test' });
  await (await DI.resolve(MigrateUpCommand)).execute({ connection: 'test' });
}
```

## Related

- [Migrations: rollback](../orm/10-migrations.md#rollback-migrationrunnerdown): what the runner does per connection.
- [Applying migrations](01-applying-migrations.md): the forward operation.
- [Customizing commands](08-customizing-commands.md): every overridable hook of every command.

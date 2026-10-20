# Resolving failed migrations

`migrate-resolve` records what really happened to a migration whose run died halfway. It accepts two row shapes: **failed** (`up()` threw, `Logs` holds the error) and **interrupted** (the process was killed before recording any outcome). Recording the outcome unblocks the connection.

```sh
spinajs migrate-resolve --name AddInvoiceIndex_2026_10_02_09_00_00 --applied       # the change IS in the database
spinajs migrate-resolve --name AddInvoiceIndex_2026_10_02_09_00_00 --rolled-back   # the change is NOT
```

## How it works

1. `MigrateResolveCommand.execute(options)` calls `MigrateResolveCommand.action(options)` first. It throws `InvalidArgument` when both `--applied` and `--rolled-back` are given, or neither. No `Orm` is resolved and no connection is opened for a malformed command line.
2. It calls [`resolveCliOrm()`](06-cli-orm.md). An ordinary `DI.resolve(Orm)` would run the boot pass, which refuses to run on a connection holding a failed row, so it would fail on the very row this command clears.
3. It calls `orm.Migration.resolve(name, action)` with `'applied'` or `'rolled-back'`. The runner finds the connection that owns the migration and forwards to its migration service. It takes no migration lock, because the run that died may still hold it.
4. The service refuses, with `OrmException`, a row that is neither failed nor interrupted: healthy, already resolved, or absent (message contains `not in failed state`). The error passes through unchanged.
5. The runner throws `OrmException` when the migration is registered but its connection is not configured.
6. On success the command logs, at `success` level:
   - `applied`: `Migration <name> is now recorded as applied. It will not run again.`;
   - `rolled-back`: `... recorded as rolled back. It is pending again and WILL run on the next migrate-up.`

What each action writes to the tracking row is listed in [Migrations: recovering from a failed run](../orm/10-migrations.md#recovering-from-a-failed-run).

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `-n, --name [name]` | `string` | required | Migration class name |
| `--applied` | `boolean` | `false` | The change is in the database. Record the migration as applied; it never runs again |
| `--rolled-back` | `boolean` | `false` | The change is not in the database. Record the migration as rolled back; it runs on the next `migrate-up` |

Exactly one of `--applied` and `--rolled-back`. Neither the CLI nor the ORM can find out which is true; you state it.

`execute()` takes `IMigrateResolveCommandOptions`: `{ name: string; applied?: boolean; rolledBack?: boolean }`.

## Exit codes

| Result | Exit code |
| --- | --- |
| The outcome was recorded | `0` |
| Both flags or neither, a row that is not failed or interrupted, a migration on an unconfigured connection | `-1` (255 on POSIX) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateResolveCommand` | Class token `MigrateResolveCommand`, singleton; also under `'__cli_command__'`. Resolved lazily by `Cli` when `migrate-resolve` runs | `MigrateResolveCommand` | none shipped | `DI.register(MySub).as(MigrateResolveCommand)`; override `action(options)` to change how the flags map to a `MigrationResolveAction`, or `execute()` to add steps around the resolve. See [Customizing commands](08-customizing-commands.md) |

### `MigrateResolveCommand`: keep an audit trail of manual resolutions

A resolve overrides what the migration runner recorded, so many teams want to know who did it and why.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MigrationResolveAction } from '@spinajs/orm';
import { IMigrateResolveCommandOptions, MigrateResolveCommand } from '@spinajs/orm-cli';
import * as fs from 'node:fs';

/** Requires RESOLVE_TICKET and appends every resolution to migrations-audit.log. */
export class AuditedMigrateResolveCommand extends MigrateResolveCommand {
  protected action(options: IMigrateResolveCommandOptions): MigrationResolveAction {
    if (!process.env.RESOLVE_TICKET) {
      throw new InvalidArgument('set RESOLVE_TICKET to the incident ticket before resolving a migration by hand');
    }

    return super.action(options);
  }

  public async execute(options: IMigrateResolveCommandOptions): Promise<void> {
    await super.execute(options);

    const line = [new Date().toISOString(), process.env.USER ?? 'unknown', process.env.RESOLVE_TICKET, options.name, options.applied ? 'applied' : 'rolled-back'];
    fs.appendFileSync('migrations-audit.log', `${line.join('\t')}\n`);
  }
}

// In your own CLI entry point, before `DI.resolve(Cli)`:
DI.register(AuditedMigrateResolveCommand).as(MigrateResolveCommand);
```

`action()` runs before the `Orm` is resolved, so a refusal there opens no connection.

## Important behaviour

- **Resolve is a statement, not a check.** `--applied` on a change that is not in the database leaves the schema behind the tracking table, and nothing will notice.
- **`--rolled-back` makes the migration pending again.** The next `migrate-up` runs it, from the top.
- **An interrupted row is accepted too.** Use it when you know the killed run finished or never started its changes; otherwise the next `migrate-up` re-runs it silently.
- **A failed row whose class no longer exists cannot be resolved.** Delete it from the tracking table by hand.
- **A healthy row is never rewritten.** Running the same resolve twice fails the second time.

## Best practices

- Read the row's `Logs` column first: it holds the error message and stack of the failed `up()`.
- Check the schema by hand, then pick the flag. Under `Transaction.Mode: None` a failed migration can be half-applied: fix or revert the partial change first, then resolve.
- Copy the two invocations `migrate-status` prints under the table; they carry the exact class name.

## Patterns and antipatterns

```sh
# Don't: resolve as applied to "get past" a failure without checking the schema
spinajs migrate-resolve --name AddInvoiceIndex_2026_10_02_09_00_00 --applied

# Do: inspect, repair or revert the partial change, then state the outcome
spinajs migrate-status
spinajs migrate-resolve --name AddInvoiceIndex_2026_10_02_09_00_00 --rolled-back
spinajs migrate-up
```

## Examples

### Recover from a failed index migration

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MigrateResolveCommand, MigrateUpCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/**
 * The index migration failed on a duplicate key. The data was cleaned by hand and
 * the partial index dropped, so the migration is recorded as not applied and run again.
 */
async function retryIndexMigration(): Promise<void> {
  await DI.resolve(Configuration);

  const name = 'AddInvoiceIndex_2026_10_02_09_00_00';

  await (await DI.resolve(MigrateResolveCommand)).execute({ name, rolledBack: true });
  await (await DI.resolve(MigrateUpCommand)).execute({ name });

  process.exit(process.exitCode ?? 0);
}

void retryIndexMigration();
```

## Related

- [Migration status](03-migration-status.md): finds failed and interrupted rows and prints these invocations.
- [Migrations: migration states](../orm/10-migrations.md#migration-states): the row shapes.
- [The CLI `Orm`](06-cli-orm.md): why this command can run on a blocked connection.

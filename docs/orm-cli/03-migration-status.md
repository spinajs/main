# Migration status

`migrate-status` prints one line per migration per configured connection and exits `1` while anything is pending or failed. Use it as a deploy gate: "is this database current?".

```sh
spinajs migrate-status
```

```
   STATE        BATCH  CONNECTION MIGRATION
   applied          1  default    CreateInvoices_2026_10_01_09_00_00
!! FAILED           0  default    AddInvoiceIndex_2026_10_02_09_00_00
?? INTERRUPTED      0  reporting  BackfillTotals_2026_10_03_09_00_00
   pending          -  reporting  AddRevenueView_2026_10_04_09_00_00

4 migration(s): 1 applied, 1 pending, 0 rolled back, 1 interrupted, 1 failed, 0 with a checksum mismatch
```

After the summary, the command prints an explanation and two `migrate-resolve` invocations for each failed and each interrupted migration.

## How it works

1. `MigrateStatusCommand.execute()` calls [`resolveCliMigrator()`](06-cli-orm.md). Without it, the boot pass would apply pending migrations and the report would always read "all applied".
2. It calls `migrator.Runner.status()`, which returns one `IMigrationStatusEntry` per registered migration whose connection is configured, `Migration.OnStartup` or not. It takes no migration lock.
3. With no entries, it prints `No migrations are registered for any configured connection.` and returns. Exit code `0`.
4. It prints the header and one line per entry with `console.log`. The line is `<marker> <state> <batch> <connection> <name>[ drift]`:
   - marker `!!` for a failed entry, `??` for an interrupted one, blank otherwise;
   - state from `MigrateStatusCommand.state(entry)`;
   - batch from the tracking row, `-` when there is no row;
   - drift `[checksum mismatch - the file changed after it was applied]` when `checksumMismatch` is set.
5. It prints the summary line.
6. It calls `explainFailed(failed)` when any entry failed, then `explainInterrupted(interrupted)` when any was interrupted.
7. It sets `process.exitCode = 1` when any entry is failed or pending.

## States

`state(entry)` checks the flags in this order and prints the first match:

| Order | Flag on `IMigrationStatusEntry` | State printed | Marker | Blocks `migrate-up` | Exit code |
| --- | --- | --- | --- | --- | --- |
| 1 | `failed` | `FAILED` | `!!` | yes, every later run on the connection | `1` |
| 2 | `applied` | `applied` | none | no | `0` |
| 3 | `interrupted` | `INTERRUPTED` | `??` | no; the next `migrate-up` re-runs it | `1` |
| 4 | `rolledBack` | `rolled-back` | none | no; the next `migrate-up` runs it | `1` |
| 5 | none of the above | `pending` | none | no | `1` |

The row shapes behind each flag are in [Migrations: migration states](../orm/10-migrations.md#migration-states). `rolled-back` appears only after `migrate-resolve --rolled-back`; `migrate-down` deletes the row, so the migration reads as `pending`.

The summary splits `pending` from the runner into `pending` (never run), `rolled back` and `interrupted`; the three are disjoint. A failed entry is never counted as pending.

## Exit codes

| Result | Exit code |
| --- | --- |
| Every migration applied, or none registered | `0` |
| Any migration pending, rolled back, interrupted or failed | `1` |
| `Orm` cannot be resolved (configuration, connection) | `-1` (255 on POSIX) |

A checksum mismatch alone does not set exit code `1`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateStatusCommand` | Class token `MigrateStatusCommand`, singleton; also under `'__cli_command__'`. Resolved lazily by `Cli` when `migrate-status` runs | `MigrateStatusCommand` | none shipped | `DI.register(MySub).as(MigrateStatusCommand)`; override `state(entry)` for the STATE column, `explainFailed(failed)` and `explainInterrupted(interrupted)` for the guidance printed below the table. See [Customizing commands](08-customizing-commands.md) |

### `MigrateStatusCommand`: point operators at your runbook

```ts sample
import { DI } from '@spinajs/di';
import { IMigrationStatusEntry } from '@spinajs/orm';
import { MigrateStatusCommand } from '@spinajs/orm-cli';

/** Adds the team's recovery runbook under the shipped guidance for failed migrations. */
export class RunbookMigrateStatusCommand extends MigrateStatusCommand {
  protected explainFailed(failed: IMigrationStatusEntry[]): void {
    super.explainFailed(failed);
    console.log('');
    console.log('Runbook: https://wiki.example.com/db/failed-migration');
    console.log(`Page #db-oncall if ${failed.map((f) => f.connection).join(', ')} is a production connection.`);
  }
}

// In your own CLI entry point, before `DI.resolve(Cli)`:
DI.register(RunbookMigrateStatusCommand).as(MigrateStatusCommand);
```

The table itself is printed inside `execute()`. For another output format, write a separate command on `resolveCliMigrator()`; see [Customizing commands](08-customizing-commands.md#write-a-new-command-on-the-cli-migrator).

## Important behaviour

- **Output goes to stdout through `console.log`, not the logger.** A log level or target cannot swallow the report, so it can be piped and grepped. The bin's welcome line still goes through the logger.
- **`0` means nothing is pending, not that the database is reachable and configured.** With no connections configured, nothing is registered and the command exits `0`. A gate that must catch a broken config should also check that the report listed migrations.
- **Every configured connection is reported**, including those with `Migration.OnStartup: false`. There is no `--connection` filter: the report is the deploy gate, and a gate that can be narrowed can be talked past.
- **Migrations for another environment are not listed.** The ORM drops them at discovery; see [Migrations: environments](../orm/10-migrations.md#environments).
- **Migrations on unconfigured connections are not listed.** `migrate-up --name` reports those separately.
- **`INTERRUPTED` is the opposite warning to `FAILED`.** It blocks nothing, and the next `migrate-up` re-runs the migration from the top. Under the default `Transaction.Mode: None`, non-idempotent data changes get applied twice.
- **With `Migration.Lock.Enabled: false`, every open row reads as interrupted**, including one a live run holds.
- **A string `startedAt` is printed as is.** A dialect that returns timestamps as strings does not break the interrupted report.

## Best practices

- Gate a deploy on the exit code, and fail on any `!!` or `??` line before running `migrate-up`.
- Treat `[checksum mismatch ...]` as a code review signal: an applied migration was edited. Add a new migration instead.
- Parse lines by their first token (`!!`, `??` or the state); connection and migration names share the line.

## Patterns and antipatterns

```sh
# Don't: grep for a word that can also appear in a connection or migration name
spinajs migrate-status | grep -q pending && exit 1

# Do: rely on the exit code, which covers pending, rolled back, interrupted and failed
spinajs migrate-status || exit 1
```

## Examples

### Deploy gate in CI

```sh
#!/bin/sh
set -e
spinajs migrate-status --env production > migrate-status.txt || {
  cat migrate-status.txt
  if grep -qE '^(!!|\?\?)' migrate-status.txt; then
    echo "A failed or interrupted migration needs an operator. Not migrating."
    exit 1
  fi
  spinajs migrate-up --env production
  spinajs migrate-status --env production
}
```

## Related

- [Resolving failed migrations](04-resolving-failed-migrations.md): what to do with a `FAILED` or `INTERRUPTED` line.
- [Migrations: status and resolve](../orm/10-migrations.md#status-and-resolve): the runner side.
- [Running the CLI: exit codes](../cli/01-running-the-cli.md#exit-codes): how the bin turns `process.exitCode` into the process exit code.

# Migration status

`migrate-status` prints one line per migration per configured connection, when each applied migration was applied, and the pending ones in the order `migrate-up` applies them. It exits `1` while anything is pending or failed. Use it as a deploy gate: "is this database current?".

It only reads. It creates and upgrades no tracking table, so running it against a fresh database leaves the database as it was.

```sh
spinajs migrate-status
spinajs migrate-status --connection reporting
spinajs migrate-status --json
```

```
   STATE        BATCH  APPLIED AT               CONNECTION MIGRATION
   applied          1  2026-10-01T09:00:12.000Z default    CreateInvoices_2026_10_01_09_00_00
!! FAILED           0  -                        default    AddInvoiceIndex_2026_10_02_09_00_00
?? INTERRUPTED      0  -                        reporting  BackfillTotals_2026_10_03_09_00_00
   pending          -  -                        reporting  AddRevenueView_2026_10_04_09_00_00

4 migration(s): 1 applied, 1 pending, 0 rolled back, 1 interrupted, 1 failed, 0 with a checksum mismatch

Pending, in the order migrate-up applies them:
  AddRevenueView_2026_10_04_09_00_00 ( reporting )
```

## Options

| Option | Effect |
| --- | --- |
| `-c, --connection <name>` | Report one connection, by name or alias. A name nothing answers to throws. |
| `--json` | Print one JSON document instead of the table. The exit code is unchanged. |

```json
{
  "entries": [
    {
      "name": "CreateInvoices_2026_10_01_09_00_00",
      "connection": "default",
      "state": "applied",
      "batch": 1,
      "appliedAt": "2026-10-01T09:00:12.000Z",
      "startedAt": "2026-10-01T09:00:11.000Z",
      "checksumMismatch": false
    }
  ],
  "pending": [{ "name": "AddRevenueView_2026_10_04_09_00_00", "connection": "reporting" }]
}
```

`appliedAt` is `null` for any entry that is not applied. `pending` is sorted by the migration timestamp, the order `migrate-up` applies them in across connections.

After the summary, the command prints an explanation and two `migrate-resolve` invocations for each failed and each interrupted migration.

## How it works

1. `MigrateStatusCommand.execute()` calls [`resolveCliMigrator()`](06-cli-orm.md), which boots the `Orm` without the application's boot check. An ordinary `DI.resolve(Orm)` would reject with `PendingMigrationsException` on the very state this command reports.
2. It calls `migrator.Runner.status({ readOnly: true, connection })`, which returns one `IMigrationStatusEntry` per registered migration whose connection is configured, whatever the connection's `Migration.Check` mode. It takes no migration lock.
3. With no entries, it prints `No migrations are registered for any configured connection.` and returns; with `--json` it prints `{"entries":[],"pending":[]}` instead. Exit code `0`.
4. It prints the header and one line per entry with `console.log`. The line is `<marker> <state> <batch> <applied at> <connection> <name>[ drift]`:
   - marker `!!` for a failed entry, `??` for an interrupted one, blank otherwise;
   - state from `MigrateStatusCommand.state(entry)`;
   - batch from the tracking row, `-` when there is no row;
   - applied at, the finish time of an applied entry, `-` otherwise;
   - drift `[checksum mismatch - the file changed after it was applied]` when `checksumMismatch` is set.
5. It prints the summary line and, when anything is pending, the `Pending, in the order migrate-up applies them:` list.
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
| `MigrateStatusCommand` | Class token `MigrateStatusCommand`, singleton; also under `'__cli_command__'`. Resolved lazily by `Cli` when `migrate-status` runs | `MigrateStatusCommand` | none shipped | `DI.register(MySub).as(MigrateStatusCommand)`; override `state(entry)` for the STATE column, `printTable(entries, pending)` for the whole table, `toJson(entry)` for the `--json` entries, `explainFailed(failed)` and `explainInterrupted(interrupted)` for the guidance printed below the table. See [Customizing commands](08-customizing-commands.md) |

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

The table is printed by the protected `printTable()` and each `--json` entry is built by `toJson()`, so a subclass can change either. For a different report altogether, write a separate command on `resolveCliMigrator()`; see [Customizing commands](08-customizing-commands.md#write-a-new-command-on-the-cli-migrator).

## Important behaviour

- **Output goes to stdout through `console.log`, not the logger.** A log level or target cannot swallow the report, so it can be piped and grepped. The bin's welcome line still goes through the logger.
- **`--json` keeps stdout clean.** `console.log` and `console.info` are routed to stderr while the report is collected, so a logger target that writes to the console cannot put log lines into the document. Logging that bypasses `console` (a direct `process.stdout.write`) is not covered.
- **`0` means nothing is pending, not that the database is reachable and configured.** With no connections configured, nothing is registered and the command exits `0`. A gate that must catch a broken config should also check that the report listed migrations.
- **Every configured connection is reported** unless `--connection` narrows it, including those whose `Migration.Check` is `'warn'` or `'off'`. A gate that must cover the whole database should not pass `--connection`.
- **It answers what the application's boot check answers.** Both read the tracking tables read-only; the boot check refuses where this command exits `1` (on `'fail'` connections). Interrupted migrations count as pending for both.
- **The command never creates a table.** On a database without a tracking table every migration reads pending; a legacy table that predates the `FinishedAt` column is read as applied, as the upgrade would backfill it.
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

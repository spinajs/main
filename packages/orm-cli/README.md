# @spinajs/orm-cli

Command line front end for spinajs ORM migrations. Six commands — apply, seed, roll back,
report, force a state, scaffold — over `OrmMigrator` and its `Runner` in `@spinajs/orm`.

`npx spinajs migrate-up` is the deploy step. The application never migrates: its `Orm.resolve()`
fails with `PendingMigrationsException` while a migration is pending or failed, so run
`migrate-up` before the application starts.

The package is a thin wrapper on purpose. Everything that decides what a migration run means
lives in `@spinajs/orm`; what lives here is the argument handling, the operator-facing wording
and the exit codes. The dependency runs one way only — `orm-cli` → `orm` — so the ORM stays
usable, and testable, with no CLI in its dependency tree.

## Documentation

Full documentation lives in **[docs/](../../docs/orm-cli/README.md)**.

| # | Page |
| --- | --- |
| 01 | [Applying migrations](../../docs/orm-cli/01-applying-migrations.md) |
| 02 | [Rolling back migrations](../../docs/orm-cli/02-rolling-back-migrations.md) |
| 03 | [Migration status](../../docs/orm-cli/03-migration-status.md) |
| 04 | [Resolving failed migrations](../../docs/orm-cli/04-resolving-failed-migrations.md) |
| 05 | [Scaffolding migrations](../../docs/orm-cli/05-scaffolding-migrations.md) |
| 06 | [The CLI migrator](../../docs/orm-cli/06-cli-orm.md) |
| 07 | [Command discovery](../../docs/orm-cli/07-command-discovery.md) |
| 08 | [Customizing commands](../../docs/orm-cli/08-customizing-commands.md) |
| 09 | [Seeding](../../docs/orm-cli/09-seeding.md) |

## Install

```bash
npm i @spinajs/orm-cli
```

The package ships a config fragment that appends its own command directory to
`system.dirs.cli`, which is where `@spinajs/cli` looks for commands. Installing it is therefore
enough — `spinajs migrate-status` works with no import and no wiring on your side. If your
application builds its own command list instead, `import '@spinajs/orm-cli'` is all that is
needed: `@Command` registers each class in DI the moment the module is evaluated.

The commands are also plain DI classes, so a script can drive them without commander:

```ts
import { DI } from '@spinajs/di';
import { MigrateStatusCommand } from '@spinajs/orm-cli';

await (await DI.resolve(MigrateStatusCommand)).execute();
```

## The commands boot in tool mode

An application's `DI.resolve(Orm)` runs the boot check (`OrmMigrationGuard`): it refuses to
start while any migration is pending or failed. For an application that is the point. For a
migration tool it would be a dead end: `migrate-up` could never start on the pending migrations
it exists to apply, `migrate-status` could not report them, and `migrate-resolve` could not reach
the FAILED row it exists to clear.

So the commands resolve the migrator through `resolveCliMigrator()`, which calls
`resolveMigrationTool()` of `@spinajs/orm`: `OrmMigrationGuard` with `{ Enabled: false }`, then
the `Orm`, then `OrmMigrator` over it. Everything else about resolving happens — connections,
models, value converters, table info — only the check is skipped, and nothing is applied on the
way in. Tool mode does not read `Migration.OnStartup` either, so `migrate-up` still runs on a
configuration written for 3.0; the application's boot then names the key to remove. A host process
whose application `Orm` already booted is refused with an `OrmException`; one whose boot failed
cached nothing, so the commands run.

The Orm reads the models' tables without the `db.StrictTableCheck` error, so the commands work on a
fresh database. A full `migrate-up` (no `--name`, no `--connection`) applies the check after its run and
exits `1` when a registered model still has no table.

Worth knowing:

- **`migrate-up` seeds what it applies.** It runs `OrmMigrator.migrate()`: the migrations, a
  re-read of the table info they touched, then their `data()` hooks. `--fake` and `--skip-seed`
  seed nothing; `migrate-seed` reruns the seeds of applied migrations.
- **Several `migrate-up` runs at once are safe.** Each holds one lock per connection for the whole
  run, seeds included, so replicas that all run it in their deploy wait for each other.
- **Other packages' commands are not in tool mode.** The CLI commands of `@spinajs/authn-keys`,
  `authn-local`, `authn-orm`, `authn-token`, `authn-totp`, `authz-orm`, `authz-rbac`, `scheduler`,
  `upload` and `users` boot the Orm as an application does, so they refuse an unmigrated database:
  run `migrate-up` first.

## Commands

| Command | Options | Does |
| --- | --- | --- |
| `migrate-up` | `-n, --name [name]`, `-c, --connection [connection]`, `-f, --fake`, `--skip-seed`, `--dry-run` | Applies pending migrations on every configured connection, then their `data()` seeds |
| `migrate-seed` | `-n, --name [name]`, `-c, --connection [connection]` | Reruns the `data()` seeds of the applied migrations |
| `migrate-down` | `-n, --name [name]`, `-c, --connection [connection]`, `-a, --all`, `-f, --fake` | Rolls back — **the last applied batch only** unless `--all` |
| `migrate-status` | `-c, --connection [connection]`, `--json` | Prints one line per migration per connection, with its applied-at time, and the pending list; the deploy gate |
| `migrate-resolve` | `-n, --name [name]` (required), `--applied`, `--rolled-back` | Records the outcome of a FAILED migration |
| `migrate-create` | `-n, --name [name]` (required), `-d, --dir [dir]`, `-c, --connection [connection]` | Scaffolds a migration file |

### `migrate-up`

```bash
spinajs migrate-up
spinajs migrate-up --name AddUserTable_2026_07_29_10_00_00
spinajs migrate-up --connection reporting   # this connection only
spinajs migrate-up --fake            # record as applied without running anything
spinajs migrate-up --skip-seed       # apply, run no data() seeds
spinajs migrate-up --dry-run         # print the plan, apply nothing; exit 1 when something would run
```

Without `--name` it applies everything pending, in `(timestamp, name)` order, across every
configured connection. With `--name` it applies exactly that one.

`--connection` limits the run to one connection. Every other configured connection is left
completely untouched — its migration service is never reached, so its tracking table is not even
created. The name is matched against the configured connections (aliases included, since they
resolve to the same connection), and one nothing answers to **throws** rather than running
nothing: a filter that silently matched nothing would exit `0` reporting "0 migrations applied".

Two named-run outcomes are deliberately **not** reported as success:

- the name matches nothing in the registry — the facade throws rather than returning an empty
  list, because "0 migrations applied" from a typo is indistinguishable from "already current";
- the name is registered but the connection it declares is not configured in this deployment.
  The facade only warns and returns `[]` there, so this command checks `status()` afterwards and
  exits non-zero with an explanation.

### `migrate-down`

```bash
spinajs migrate-down                 # the LAST APPLIED BATCH, not everything
spinajs migrate-down --all           # every applied migration, on every connection
spinajs migrate-down --name AddUserTable_2026_07_29_10_00_00
spinajs migrate-down --connection reporting --all   # everything, on one connection
```

The default scope is the last applied batch — one `migrate-up` run undone, not the whole
history. `--all` reverses everything. `--connection` narrows whichever of those two applies, and
is announced first for that reason: `--all --connection reporting` is "every applied migration on
*one* connection". The command says which scope it is about to reverse *before* it does it,
because by the time the result line prints, the schema has already changed.

A rollback drops the tracking row rather than stamping it "rolled back": the table is meant to
hold only migrations that are actually present in the database, and both a missing row and a
rolled-back one read as pending to the next `migrate-up`.

`--name` has a known sharp edge in the migration service: it is handed a one-element unit list,
so every *other* applied row in the target batch looks unmatched and gets warned about as
"no registered migration matches them (file deleted or renamed)". Those rows are healthy, and
the remedy that warning suggests — removing the row by hand — is destructive here. This command
prints a line saying exactly that before the run, so the warnings can be ignored.

### `migrate-status`

```bash
spinajs migrate-status
spinajs migrate-status --connection reporting
spinajs migrate-status --json
```

```
   STATE        BATCH  APPLIED AT               CONNECTION MIGRATION
   applied          1  2026-07-29T10:00:12.000Z default    AddUserTable_2026_07_29_10_00_00
!! FAILED           0  -                        default    AddOrderIndex_2026_07_29_11_00_00
?? INTERRUPTED      0  -                        default    BackfillTotals_2026_07_29_12_00_00
   pending          -  -                        default    AddInvoices_2026_07_30_09_00_00
```

The table is followed by a summary line and the pending migrations in the order `migrate-up`
applies them. The format is described in
[Migration status](../../docs/orm-cli/03-migration-status.md).

Output goes to stdout via `console.log`, not through the framework logger: it is this command's
*product*, something an operator greps and a script pipes, and routing it through the log would
let a configured level or target swallow it.

A failed row carries `!!` in the leftmost column, not just the word `FAILED`. That row is the
one line in the report that stops every later `migrate-up` on its connection, and it has to
survive being skimmed in a wall of `applied`. Below the table the command prints the two exact
`migrate-resolve` invocations for each failed migration.

`??` marks an **interrupted** migration — one that was started and never finished, because the
process running it was killed before it could record either outcome. It carries the opposite
warning to `FAILED`: it blocks nothing, and the next `migrate-up` re-runs it from the top, whether
or not anybody looked. Under the default `Transaction.Mode: None` that means non-idempotent data
changes get applied twice, silently. The same two `migrate-resolve` invocations are printed for
it. See "Migration states" in
[the ORM migration docs](../../docs/orm/10-migrations.md#migration-states).

`[checksum mismatch]` marks a migration whose source changed after it was applied. It is
reported but does **not** on its own make the command exit non-zero — only pending and failed
work do.

### `migrate-resolve`

The escape hatch for a run that died halfway. Valid on the two row shapes whose real outcome
nobody recorded — **failed** (`FinishedAt` NULL and `Logs` set) and **interrupted** (`StartedAt`
set, `FinishedAt` and `Logs` both NULL). Anything healthy, rolled back or absent is refused rather
than silently rewritten.

```bash
spinajs migrate-resolve --name AddOrderIndex_2026_07_29_11_00_00 --applied      # the change IS in the database
spinajs migrate-resolve --name AddOrderIndex_2026_07_29_11_00_00 --rolled-back  # the change is NOT
```

Exactly one of the two flags, never both and never neither: the point of the command is to state
which of the two things actually happened, and neither the CLI nor the ORM can find that out on
its own. The refusal happens before any Orm is resolved, so a malformed command line never opens
a database connection.

`--rolled-back` makes the migration pending again — it *will* run on the next `migrate-up`.

### `migrate-create`

```bash
spinajs migrate-create --name AddInvoices
spinajs migrate-create --name AddInvoices --dir ./src/migrations --connection reporting
```

Prints the path it wrote, on its own line, so `$(spinajs migrate-create -n AddInvoices)` is
usable. Defaults: `./src/migrations` and the `default` connection.

`--name` takes the *prefix* only, letters and digits, starting with a letter. The
`_yyyy_MM_dd_HH_mm_ss` suffix is appended here, and it is not decoration: that timestamp is the
only ordering the migration runner has, and it is read back out of the class name. A name the
runner cannot parse is refused up front, and an existing file is never overwritten.

The generated class only takes effect once it is *imported* — the `@Migration` decorator has to
run to register it. Re-export it from your package or application index, the way `src/migrations/*.ts`
files are re-exported elsewhere in spinajs.

## Exit codes

| Command | `0` | non-zero |
| --- | --- | --- |
| `migrate-up` | migrations applied, or nothing was pending; `--dry-run` with nothing to apply | a named run applied nothing because its connection is not configured, or it is still pending/failed; a full run leaves a model without its table; `--dry-run` with something to apply or a FAILED migration; a `--connection` nothing answers to; any error from the run |
| `migrate-seed` | seeds ran, or nothing is applied | a `--name` not registered or not applied; a `--connection` nothing answers to; a `data()` hook that throws |
| `migrate-down` | rollback completed, or nothing to roll back | a `--connection` nothing answers to; any error from the run |
| `migrate-status` | every migration is applied | anything is pending or failed |
| `migrate-resolve` | the state was recorded | both/neither flag given; the row is neither failed nor interrupted |
| `migrate-create` | file written | invalid name or connection; the file already exists |

`migrate-status` is meant to be a deploy gate — "is this database current?" — so an un-run
migration is a "no", not just a failed one.

Two things the table does not say:

- **A `0` from `migrate-status` means "nothing is pending", not "the database is reachable and
  configured".** With no connections configured, nothing is registered, so nothing is pending and
  the command exits `0`. A gate that must also catch a failed config should check that the command
  reported migrations at all.
- **Requires a `@spinajs/cli` that propagates `process.exitCode`.** Earlier versions ended the
  bin's success path with a bare `process.exit(0)`, which discards whatever a command set — driven
  through such a bin, `migrate-status` exits `0` even with pending work. If you are pinned to one,
  call the command class directly (see the snippet at the top) rather than going through the bin.

## The blocking guarantee is best-effort

A failed migration blocks every later `migrate-up` on its connection. That is what makes
`migrate-status` + `migrate-resolve` a safe recovery loop instead of a suggestion: a half-applied
schema change cannot be built on top of.

The guarantee holds only as far as the bookkeeping does. When a migration fails, the ORM writes
the failure into the tracking table — and if *that* write fails too (the connection dropped, the
table is locked), the error is caught and logged rather than raised. The run still fails, but the
row that would have blocked the next `migrate-up` was never written, and the next run proceeds as
if nothing had happened.

In practice this needs the database to fail twice, in a specific order. It matters when you are
reading logs after an incident: a `migrate-up` that succeeded shortly after a failed one is not
by itself proof that the failure was resolved. Check `migrate-status`.

## Notes

- Migrations run on a resolved Orm, but a model of a table the run creates has no columns until
  the run re-reads the touched models, after its last `up()`. Use the `OrmDriver` passed to `up()`; seed through models in `data()`.
- `--fake` records the outcome without executing anything, on both `migrate-up` and
  `migrate-down`. It is for a database that was changed out of band and needs the tracking table
  brought in line.
- `migrate-status` reports every configured connection unless `--connection` narrows it,
  including ones whose `Migration.Check` is `'warn'` or `'off'`. A deploy gate should not pass
  `--connection`: a gate that can be narrowed is a gate that can be talked past.

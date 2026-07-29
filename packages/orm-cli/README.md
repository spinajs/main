# @spinajs/orm-cli

Command line front end for spinajs ORM migrations. Five commands — apply, roll back, report,
force a state, scaffold — over the `orm.Migration` facade in `@spinajs/orm`.

The package is a thin wrapper on purpose. Everything that decides what a migration run means
lives in `@spinajs/orm`; what lives here is the argument handling, the operator-facing wording
and the exit codes. The dependency runs one way only — `orm-cli` → `orm` — so the ORM stays
usable, and testable, with no CLI in its dependency tree.

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

## Running a command never migrates anything

Every command starts by resolving an `Orm`, and an ordinary `DI.resolve(Orm)` ends with the boot
migration pass — every pending migration on every connection whose `Migration.OnStartup` is on.
For an application that is the point. For a migration tool it is a trap, twice over:

- a connection holding a **failed** migration refuses every migration run, so the resolve throws
  before the command body starts. That took down every command on the row it was invoked about,
  including `migrate-resolve` — the one command that clears it, and the one the refusal names as
  the remedy.
- `migrate-status` would apply everything pending and only then report, so the deploy gate asking
  "is this database current?" made it current, answered "yes" and exited `0`, with the DDL it was
  meant to hold back already run.

So the commands resolve their Orm through `resolveCliOrm()`, which passes `MigrateOnStartup:
false` (an `IOrmOptions` field of `@spinajs/orm`). Everything else about resolving happens —
connections, models, value converters, `orm.Migration` — only the boot pass is skipped. It is
opt-**in**: nothing changes for an application that resolves an Orm the ordinary way, and this
package ships no configuration that would switch startup migrations off for anybody.

Two consequences worth knowing:

- `migrate-up --fake` means what it says on a `Migration.OnStartup` connection. A boot pass would
  have really applied the migrations the flag promises only to record.
- **A migration applied by the CLI never gets its `data()` hook.** Seeding belongs to the boot
  pass: `Orm.resolve()` seeds what its own startup run applied, and a later boot finds the
  migration already applied and seeds nothing. That was already true of every connection with
  `Migration.OnStartup` off; it is now true of all of them. Migrations that must be seeded have to
  be applied by an application boot, not by `migrate-up`.

## Commands

| Command | Options | Does |
| --- | --- | --- |
| `migrate-up` | `-n, --name [name]`, `-c, --connection [connection]`, `-f, --fake` | Applies pending migrations on every configured connection |
| `migrate-down` | `-n, --name [name]`, `-c, --connection [connection]`, `-a, --all`, `-f, --fake` | Rolls back — **the last applied batch only** unless `--all` |
| `migrate-status` | — | Prints one line per migration per connection; the deploy gate |
| `migrate-resolve` | `-n, --name [name]` (required), `--applied`, `--rolled-back` | Records the outcome of a FAILED migration |
| `migrate-create` | `-n, --name [name]` (required), `-d, --dir [dir]`, `-c, --connection [connection]` | Scaffolds a migration file |

### `migrate-up`

```bash
spinajs migrate-up
spinajs migrate-up --name AddUserTable_2026_07_29_10_00_00
spinajs migrate-up --connection reporting   # this connection only
spinajs migrate-up --fake            # record as applied without running anything
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
```

```
   STATE         BATCH  CONNECTION       MIGRATION
   applied           1  default          AddUserTable_2026_07_29_10_00_00
!! FAILED            0  default          AddOrderIndex_2026_07_29_11_00_00
?? INTERRUPTED       0  default          BackfillTotals_2026_07_29_12_00_00
   pending           -  default          AddInvoices_2026_07_30_09_00_00
```

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
it. See "Interrupted runs" in
[the ORM migration docs](../orm/docs/10-schema-and-migrations.md#interrupted-runs).

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
| `migrate-up` | migrations applied, or nothing was pending | a named run applied nothing because its connection is not configured, or it is still pending/failed; a `--connection` nothing answers to; any error from the run |
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

- Migrations run against a schema no model is wired to yet. Use the `OrmDriver` passed to `up()`,
  never a model class. The `data()` hook runs later, once models are available.
- `--fake` records the outcome without executing anything, on both `migrate-up` and
  `migrate-down`. It is for a database that was changed out of band and needs the tracking table
  brought in line.
- `migrate-status` reports every configured connection, including ones whose
  `Migration.OnStartup` is off — hiding those would answer "nothing to see" for exactly the
  connections somebody is most likely asking about. It has no `--connection` of its own, for the
  same reason: the report is the deploy gate, and a gate that can be narrowed is a gate that can
  be talked past.

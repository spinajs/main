# Schema and migrations

## Migrations

A migration extends `OrmMigration` and carries `@Migration(connectionName)`. The decorator
registers it under the `__migrations__` DI key.

### The name is data

The class name **must** end in `_yyyy_MM_dd_HH_mm_ss`, matched by
`/(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/`. The stamp is parsed with luxon
and used to order migrations. A name that does not match throws:

```
Migration file X have invalid name format ( invalid migration name, expected:
some_name_yyyy_MM_dd_HH_mm_ss got X )
```

### Environments

A migration may belong to one environment. The environment is a dot-suffix on the FILE name — the
same convention `@spinajs/configuration` uses for config files:

```
src/migrations/
  CreateUsers_2026_07_29_10_00_00.ts         every environment
  SeedTestData_2026_07_29_10_05_00.local.ts  APP_ENV=local only
  SeedFixtures_2026_07_29_10_06_00.dev.ts    APP_ENV=dev or development
```

The tag is matched after the same normalization config files get: `development` and `dev` are one
environment, `production` and `prod` are another, anything else is taken verbatim. Case is not
folded — `Local` and `local` are different.

An explicitly empty `APP_ENV`, or `process.env.APP_ENV` read with nothing set at all, normalizes to
`prod` — but a real boot never reaches that fallback. `Configuration` sets `process.env.APP_ENV`
itself, before the ORM ever reads it, to `this.Env ?? env?.APP_ENV ?? process.env.NODE_ENV ??
'development'` (`packages/configuration/src/configuration.ts`). So a process started with neither
`--env` / `APP_ENV` nor `NODE_ENV` set runs as `development`, normalized to `dev` — **not** `prod`.
The `.dev.ts` example above is exactly what such a box runs.

A migration belonging to another environment is **entirely invisible**: it is never imported, never
registered, and absent from `migrate-up`, `migrate-down` and `migrate-status` alike. One
consequence is worth knowing before you rely on it — a `.local` migration applied on a machine that
later boots as another environment leaves a tracking row with no migration behind it, and
`migrate-down` reports that row as an orphan whose file was "deleted or renamed". Nothing is
actually wrong; do not follow that advice for such a row.

Scaffold one with the CLI:

```bash
spinajs migrate-create --name SeedTestData --env local
```

#### How the tag is read

The parser looks only at the file's basename, and only trusts a filename that is a migration file
in the first place: its first dot-segment must carry the same `_yyyy_MM_dd_HH_mm_ss` stamp every
migration class name is stamped with. A name that doesn't carry that stamp — a test helper, a
Storybook file, anything else that merely has dots in its name — has no tag to read, no matter how
many dots follow.

Given a file whose first segment does carry the stamp:

- **two segments** (`Name_...ts`, `Name_...js`) — unsuffixed, every environment;
- **three segments** where the middle one is `d` and the extension is `ts` (`.d.ts`), or the middle
  one is `test` or `spec` with extension `ts` or `js` — these are carved out by name rather than
  read as a tag, because they name a *kind of file* the migration produced (a declaration file, a
  test suite named after the migration it tests), not an environment it should run in;
- **any other three-segment name** — the middle segment, normalized, is the tag;
- **more than three segments**, or an empty middle segment (`Foo..ts`) — the boot throws, because a
  migration cannot carry two tags or an empty one.

`.d.js` is not a declaration-file convention, so `Foo_..._00.d.js` is read as environment `d` — an
edge case worth knowing rather than relying on.

#### Where migrations are found

`FilesystemMigrationSource` scans the directories configured at `system.dirs.migrations`. That key
ships as an **empty array** — package configs merge into the app's config by array concat, so
anything shipped non-empty here would sit in every app's scan set forever with no way to switch it
off. When the configured value is absent or empty, the source falls back to `src/migrations`,
`lib/migrations`, `dist/migrations`, `build/migrations` and bare `migrations`, resolved against the
process's current working directory, **plus one more**: `lib/cjs/migrations` or
`lib/mjs/migrations`, whichever matches the format the current process is actually running as.

Only one of that last pair is ever scanned, never both. `lib/cjs` and `lib/mjs` are the same
migration source compiled twice — into two module formats — and every package in this repo ships
`"type": "module"` with no `package.json` written into `lib/cjs`, so Node parses a `lib/cjs/*.js`
file as ESM and a bare import of it throws. Scanning both unconditionally means a package that
ships both builds (every package here) always has one sibling the running process cannot load, and
a `.js` import failure is a hard throw by design (see below) — so the format that does not match
the runtime is never scanned at all, rather than scanned and its failure tolerated. Which format is
current is read off the same `__esmMode__` DI flag `@spinajs/configuration`'s own dual-build config
glob already keys off (`packages/configuration/src/sources.ts`); a process that never called
`DI.setESMModuleSupport()` is treated as CommonJS, matching `DI.__spinajs_require__`'s own fallback.
Configuring a value **replaces** this fallback rather than adding to it:

```js
// config file
export default {
  system: {
    dirs: {
      migrations: [`${process.cwd()}/lib/migrations`],
    },
  },
};
```

Within each configured directory, two globs run: unsuffixed files (every environment) and files
tagged for the current one, over `.ts`, `.js`, `.cjs` and `.mjs` alike — the same extension set
`@spinajs/configuration`'s own config-file loader recognizes. A file belonging to another
environment is never matched by either glob, so it is never imported — importing it would fire its
`@Migration` decorator and register it regardless of what filter ran afterwards.

`APP_ENV` is interpolated straight into that glob, so it is required to be a plain identifier
(letters, digits, `_` or `-`); anything else — a stray `{`, `[`, `!` or `*` — throws rather than
silently scanning nothing or the wrong files.

A class living in a scanned directory is only ever treated as a migration when its own name carries
the same `_yyyy_MM_dd_HH_mm_ss` stamp every migration is stamped with — the same anchor
`parseMigrationFileEnv` reads a file's tag through. A shared abstract base class is skipped rather
than reported: registering it would surface later as a boot failure naming a file nobody meant to
write as a migration. A barrel re-exporting a legitimate migration does register it — but the barrel
loses the filename's environment tag (since `index.ts` carries no `.<env>` segment), so the migration
runs in every environment unless its decorator specifies one with `@Migration({ Env })`.

A `.ts` file that fails to import is tolerated silently (logged at trace level): the default search
includes `src/migrations`, so a compiled deployment routinely fails to import the `.ts` copy of
every migration under a plain JS runtime while its compiled `.js`/`.cjs`/`.mjs` copy is found by
the same scan. A compiled file that fails to import is never a source artifact tried on spec, so a
broken one means a real syntax error, a broken relative import, or a throwing module body — but
what happens next depends on **who named the directory it lives in**:

- in a directory **configured** at `system.dirs.migrations`, the failure throws, naming the file
  and chaining the original error — the operator pointed the scan there, so a file that will not
  load is their bug and they must hear about it as a boot failure, not a quiet gap in coverage.
- in a **fallback** directory (the defaults above, scanned only because nothing was configured),
  the failure is logged at **warn** instead — naming the file, carrying the original error, and
  stating plainly that the migration was **not registered** — and the scan continues with whatever
  else it finds. Nobody asked for that directory to be scanned, so it is not this ORM's place to
  take a boot down over what it happened to find there.

A migration reached by `import` rather than by discovery — a package re-exporting its migrations
from `index.ts` — declares its environment on the decorator instead:

```ts
@Migration('default', { Env: 'local' })
export class SeedTestData_2026_07_29_10_05_00 extends OrmMigration {}
```

Both may be present, and `migrate-create --env` writes both. They must agree: a file suffixed
`.local` whose decorator says `dev` fails the boot rather than picking a winner.

A migration file living under one of the **application's own** scanned directories needs no
re-export — the filesystem source finds it directly, because `system.dirs.migrations` resolves
against the running process's cwd, which is the application. A migration scaffolded **inside a
package** sits under that package's own `src/migrations` — a directory this same fallback list
would scan too, but only for a process whose cwd is the package itself, which a consumer never is.
So a package must always re-export its migrations from its own `index.ts`; that import is what
makes the `@Migration` decorator run and register them at the consumer's runtime.

#### Plugging in your own discovery

`Orm` takes migrations from every `MigrationSource` registered in the container. Two ship with the
package — one scanning the filesystem, one reading the `@Migration` registrations — and another is
a class away:

```ts
import { ClassInfo, Injectable } from '@spinajs/di';
import { MigrationSource, OrmMigration } from '@spinajs/orm';

@Injectable(MigrationSource)
export class ManifestMigrationSource extends MigrationSource {
  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    return [{ file: '<manifest>', name: MyMigration_2026_07_29_10_00_00.name, type: MyMigration_2026_07_29_10_00_00 }];
  }
}
```

A source only discovers — it never constructs or runs anything. The `file` it reports is what the
tag rule above reads, so a source that has no real file should report a sentinel and declare the
environment on the decorator instead.

#### Known limitations

- Under a TypeScript runtime (`ts-node`, `ts-mocha`), a genuinely broken `.ts` migration is silently
  skipped rather than reported — the same tolerance that lets a compiled deployment's unusable
  `.ts` copies pass quietly applies equally to a `.ts` file that is broken for real.
- A migration exported as `export default` rather than as a named export is invisible to the
  filesystem scan, which only recognizes named exports whose value is a class extending
  `OrmMigration`.

### The three hooks

```ts sample
import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

@Migration('default')
export class CreateShop_2026_07_27_10_00_00 extends OrmMigration {
  /**
   * Schema changes. Model classes are NOT usable here — the ORM has not wired
   * them up yet. Use the schema builder and raw queries only.
   */
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('clients', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name', 128).notNull();
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('orders', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('client_id').notNull();
      table.string('Reference', 64).notNull().unique();
      table.decimal('Total', 12, 2).notNull();

      table.foreignKey('client_id').references('clients', 'Id').onDelete(ReferentialAction.Cascade).onUpdate(ReferentialAction.Cascade);
    });
  }

  /** Undo `up`. */
  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('orders');
    await connection.schema().dropTable('clients');
  }

  /**
   * Data seeding. Runs AFTER the ORM has fully initialised, so models and
   * relations are available here.
   */
  public async data(): Promise<void> {
    // await Client.insert({ Name: 'Acme' });
  }
}
```

`up()` runs during `Orm.resolve()`, before models are wired — that is why `data()` exists as a
separate hook that runs afterwards.

**`data()` belongs to the boot pass, not to the facade.** `Orm.resolve()` collects the migrations
its own startup run applied and calls their `data()` once models and relations are usable.
Nothing else does. A migration applied any other way — `orm.Migration.up()` by hand, or
`spinajs migrate-up`, which resolves its Orm with the boot pass suppressed — gets its schema and
never gets its seed, in that process or in any later one: the next boot finds it already applied,
and a boot seeds only what it applied itself. Every `data()` runs even when an earlier one throws; the failures
are collected and reported together, because stopping at the first would leave the migrations
after it recorded as applied and unseeded, with nothing to make a rerun retry them.

> **A seed is lost for good if the run it belongs to does not finish.** The `data()` phase is
> handed the migrations *this* run applied, and it happens after the whole run. So if M1 applies
> and M2 then throws, `Orm.resolve()` fails before the phase is reached — and M1's schema is
> already recorded as applied. On the next boot M1 is no longer pending, it is not in the applied
> list the phase is given, and **`M1.data()` never runs, on this boot or any other**. Nothing
> reports it: the migration is applied, `migrate-status` is clean, and only the missing rows say
> otherwise.
>
> The same applies to a migration whose own `up()` succeeded in a run a *later* `data()` hook then
> failed: `resolve()` throws the aggregate, boot fails, and the schema rows stay.
>
> There is no automatic recovery, because there is nothing recorded to recover from — the tracking
> table has no notion of "applied but unseeded". What to do about it:
>
> - **Write `data()` so that running it again is harmless** — upsert rather than insert, check
>   before you write. Then re-seeding by hand is a one-liner and never a question of "did this
>   already run?".
> - **After a failed boot, fix the cause and check the seeds of everything the failed run had
>   already applied.** The log names each one (`Migration <name>:up() success !`), and
>   `migrate-status` shows them as applied.
> - **To make one run again**, roll the migration back and re-apply it through an application
>   boot: `orm.Migration.down('<name>')`, then boot. `down()` deletes the tracking row, so the
>   next boot pass applies it and this time reaches its `data()`. That re-runs `up()` as well, so
>   it is only an option where `down()` really undoes it.
> - **Keep large or fragile seeding out of `data()`** and in a task you can run and re-run on its
>   own. `data()` is for the small, essential rows a schema is useless without.

### The facade: `orm.Migration`

Everything migration-related hangs off `orm.Migration`, a `MigrationRunner` **assigned inside
`Orm.resolve()`**, once the connections it dispatches to exist. It is not available on an
unresolved `Orm`.

| Call | Does |
| --- | --- |
| `up(name?, options?)` | Applies every pending migration on every configured connection, or only `name`. |
| `down(name?, options?)` | Rolls back — **the last batch only**, unless `{ all: true }`. |
| `status()` | `IMigrationStatusEntry[]`: one entry per registered migration per configured connection. |
| `resolve(name, 'applied' \| 'rolled-back')` | Forces the recorded state of a **failed** migration. |

| Option | On | Default | Meaning |
| --- | --- | --- | --- |
| `force` | `up`, `down` | `true` | Run even for connections whose `Migration.OnStartup` is off. Only the boot pass passes `false`. |
| `fake` | `up`, `down` | `false` | Record — or drop — the tracking row without executing the migration. |
| `all` | `down` | `false` | Roll every applied migration back instead of only the last batch. |
| `connection` | `up`, `down` | — | Limit the run to one connection, by name. Every other configured connection is left completely untouched — its service is never reached, so its tracking table is not even created. |

`up` and `down` resolve with the `OrmMigration` instances they actually ran, and `[]` when there
was nothing to do.

A `name` that matches nothing in the registry **throws**, on all of `up`, `down` and `resolve`.
Returning `[]` would make a typo indistinguishable from "already up to date", and a deploy script
would read that as success. A `connection` no configured connection answers to throws for the
same reason.

`connection` is resolved to a driver before it is compared, so a `db.Aliases` entry and the
connection it points at select the same run. `status()` has no such option on purpose: hiding a
connection is exactly how a deploy gate comes to answer "nothing to see" about the one that is
behind.

> **Breaking change.** `orm.migrateUp()` and `orm.migrateDown()` are gone. `orm.Migration.up()`
> and `orm.Migration.down()` replace them — and `down()` is *not* a drop-in: it defaults to the
> last batch, where `migrateDown()` reversed the entire history.
> `orm.Migration.down(undefined, { all: true })` is the old behaviour.

### Running them by hand

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function migrate() {
  const orm = await DI.resolve(Orm);

  // Everything pending, on every configured connection. `force` defaults to true,
  // so Migration.OnStartup is ignored here.
  const applied = await orm.Migration.up();

  // Just one, by class name. An unregistered name throws rather than returning [].
  await orm.Migration.up('CreateShop_2026_07_27_10_00_00');

  // One connection only. Nothing else is opened, migrated or even probed.
  await orm.Migration.up(undefined, { connection: 'reporting' });

  // Roll back the LAST BATCH only — one up() run undone.
  await orm.Migration.down();

  // Roll back the whole history.
  await orm.Migration.down(undefined, { all: true });

  return applied;
}
```

### Reading the state

`status()` never takes the migration lock and never writes: it is a read-only report, and
blocking it behind a running migration would stall it exactly when somebody is asking what is
going on. It reports every configured connection, including ones with `Migration.OnStartup` off.

```ts sample
import { DI } from '@spinajs/di';
import { IMigrationStatusEntry, Orm } from '@spinajs/orm';

export async function report(): Promise<IMigrationStatusEntry[]> {
  const orm = await DI.resolve(Orm);
  const entries = await orm.Migration.status();

  for (const e of entries) {
    // exactly one of applied / failed / pending is true; rolledBack and interrupted are
    // orthogonal narrowings of pending
    const state = e.applied ? `applied (batch ${e.batch ?? '-'})` : e.failed ? 'FAILED' : e.interrupted ? 'INTERRUPTED' : 'pending';

    console.log(`${e.connection} ${e.name} ${state}${e.checksumMismatch ? ' [checksum mismatch]' : ''}`);
  }

  // the deploy gate: anything not applied is a "no"
  return entries.filter((e) => e.pending || e.failed);
}
```

An `IMigrationStatusEntry` carries `name`, `connection`, `applied`, `failed`, `rolledBack`,
`pending`, `interrupted`, `batch`, `startedAt`, `finishedAt` and `checksumMismatch`. `batch`,
`startedAt` and `finishedAt` are `null` for a migration that has no row yet; the six flags are
always booleans.

`rolledBack` and `interrupted` are narrowings of `pending`, not alternatives to it: both describe
a migration the next `up()` **will** run. They are mutually exclusive — see
[interrupted runs](#interrupted-runs) for what the second one means and why it does not block.

### The lifecycle

`Orm.resolve()`, in migration-relevant order:

1. Open every connection.
2. Register the `__migrations__` and `__models__` classes DI collected; build `orm.Migration`.
3. **Register the default value converters.** This must precede the migration pass: the pass
   reaches `ensureStorage()`, which probes the tracking table with `driver.tableInfo()`, and a
   driver's `tableInfo()` may read the `__orm_db_value_converters__` map that this step is what
   fills. Running it afterwards crashed every restart of an already-migrated database.
4. `orm.Migration.up(undefined, { force: false })` — pending migrations, but only on connections
   whose `Migration.OnStartup` is on. **Skipped entirely** when the Orm was resolved with
   `MigrateOnStartup: false` — see below.
5. `reloadTableInfo()`, `wireRelations()`, `applyModelMixins()`.
6. `data()` for whatever step 4 applied — **and only if step 4 completed**. A migration that
   throws in step 4 takes the whole resolve down before step 6 runs, so the migrations that had
   already succeeded in that pass keep their recorded schema and never get their seed, on this
   boot or any later one. See [the three hooks](#the-three-hooks).

#### Resolving an Orm that must not migrate

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function inspectOnly() {
  // everything else about resolve() happens - connections, models, converters, orm.Migration -
  // but step 4 above does not run, so nothing is applied and nothing is seeded
  const orm = await DI.resolve(Orm, [{ MigrateOnStartup: false }]);

  return await orm.Migration.status();
}
```

`MigrateOnStartup` is an `IOrmOptions` field, handed over at construction rather than read from
configuration: what it describes is a property of the *process*, not of the deployment. Leave it
out and you get the documented behaviour — this is an opt-out that only a caller who says so gets.

It exists for processes whose job is to operate **on** migrations rather than with them, and
`@spinajs/orm-cli` passes it in every command. Without it a migration tool cannot work: a
connection holding a FAILED row refuses every migration run, so the boot pass takes the process
down before the command body starts — including the `migrate-resolve` invoked to clear that row,
which is the remedy the refusal itself names. And where the boot pass *succeeds*, it silently
turns `migrate-status` from a report into a migration: the deploy gate asking "is this database
current?" makes it current, answers "yes", and exits 0.

Note it is not a `force` variation. `force` chooses whether the `OnStartup` gate is honoured, and
both of its values run migrations — `force: false` runs every connection whose gate is on, which
is exactly the set a migration tool must not touch on its way in.

Within one run, per connection, in `(timestamp, name)` order:

1. `ensureStorage()` — create the tracking table and its `_lock` companion, or upgrade a legacy
   one. This happens *before* the lock is taken, because the lock table is one of the tables it
   creates and cannot guard its own creation; a lost race against another process creating the
   same table is tolerated, anything else (no permission, dead connection) is rethrown.
2. Take the migration lock, unless `Migration.Lock.Enabled` is false.
3. Read every tracking row. **`up()` refuses the whole run if any row is in the failed state.**
4. `up()` runs for every registered migration with no *applied* row. `down()` runs for every
   applied row in scope.
5. Compute the batch number: `max(Batch across applied rows) + 1`.
6. Wrap according to `Migration.Transaction.Mode`.
7. On `up`: open the row (`StartedAt` set; `FinishedAt`, `RolledBackAt` and `Logs` cleared), run
   `up(driver)`, then stamp `FinishedAt`, `Batch` and `Checksum`.
   On `down`: run `down(driver)`, then **delete** the row.
8. Release the lock, in a `finally` — a run that throws must not leave the connection locked
   until the staleness window expires.

`down()` orders newest-first: a migration has to be undone before the one it was built on top of.
Migrations sharing a timestamp fall back to reverse name order, mirroring the forward order.

### The tracking table

`Migration.Table`, default `spinajs_migration`. Eight columns:

| Column | Holds |
| --- | --- |
| `Migration` | The migration class name. Unique. |
| `CreatedAt` | When the row first appeared. |
| `StartedAt` | When the most recent attempt began. |
| `FinishedAt` | When that attempt succeeded. `NULL` while running, and after a failure. |
| `RolledBackAt` | Set by `resolve(name, 'rolled-back')`. An ordinary rollback deletes the row instead. |
| `Logs` | The failure message and stack. `NULL` on a healthy row. |
| `Checksum` | sha256 of the migration class source, as of the run that applied it. |
| `Batch` | Which `up()` run applied it. |

**Applied** means `FinishedAt NOT NULL AND RolledBackAt NULL` — that pair, not merely "a row
exists". **Failed** means `FinishedAt NULL AND Logs NOT NULL`. Everything else is pending —
including the row shape described under [interrupted runs](#interrupted-runs).

A rollback drops the row rather than stamping it: the table is meant to hold only migrations
actually present in the database, and a missing row and a rolled-back one both read as pending to
the next `up()`.

A legacy two-column table (`Migration`, `CreatedAt`) is **upgraded in place** on the first boot
that sees it — the six new columns are added, then `StartedAt` and `FinishedAt` are backfilled
from `CreatedAt` and `Batch` from `1`. Nothing is dropped and no row is lost, so a database
migrated by an older spinajs keeps its history and does not re-run anything.

`<table>_lock` is created alongside it: `Id`, `AcquiredAt`, `Owner`.

### Batches

Every `up()` run stamps one batch number onto the migrations it applied: one past the highest
`Batch` among the rows that are currently applied. It is written at *finish*, not at start, so a
migration that never completed carries no batch for a later rollback to pick up.

That gives `down()` its default scope: **the highest batch only**, which is exactly the last
`up()` run undone.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function rollback() {
  const orm = await DI.resolve(Orm);

  // The last batch. If the last `up()` applied four migrations, this undoes those four.
  await orm.Migration.down();

  // Every applied migration, oldest batch included.
  await orm.Migration.down(undefined, { all: true });

  // One named migration, wherever it sits.
  await orm.Migration.down('CreateShop_2026_07_27_10_00_00');
}
```

> **Sharp edge on `down(name)`.** The per-connection service is handed a one-element list, so
> every *other* applied row in the target batch looks unmatched and is warned about as "recorded
> as applied but no registered migration matches them (file deleted or renamed)". Those rows are
> healthy, and the remedy that warning suggests — deleting the row by hand — is destructive here.
> The rollback itself is correct; only the warning lies.

### Failure state and `resolve`

When `up()` throws, the service writes the message and stack into `Logs` and leaves `FinishedAt`
`NULL`. That row then **blocks every later `up()` on that connection**, with an error naming the
migration and pointing at `resolve`. A half-applied migration means the database is in a state
nobody described, and piling more schema changes on top of it is the one thing that must not
happen.

The failure row is written *after* any wrapping transaction has unwound — written inside it, it
would be rolled back with everything else and leave no trace of what broke.

Recovery has exactly two answers, and only you know which is true:

| Call | Says | Effect |
| --- | --- | --- |
| `resolve(name, 'applied')` | The schema change **is** in the database — you finished it by hand. | Stamps `FinishedAt` and a fresh batch, so the row joins the next default rollback. |
| `resolve(name, 'rolled-back')` | The change is **not** there. | Stamps `RolledBackAt` and clears `Logs`. The migration is pending again and the next `up()` runs it. |

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function recover(name: string, schemaChangeIsPresent: boolean) {
  const orm = await DI.resolve(Orm);

  await orm.Migration.resolve(name, schemaChangeIsPresent ? 'applied' : 'rolled-back');
}
```

`resolve()` is valid on a row in the **failed** state or in the **interrupted** state (below) —
the two shapes whose real outcome nobody recorded. Anything healthy, rolled back or absent is
refused rather than silently rewritten. Like `status()`, it deliberately does not take the lock —
it is the recovery path for a run that may well have died holding it.

Two things worth knowing before you rely on the block:

- **It is best-effort.** If the bookkeeping write itself fails — the connection dropped, the
  table is locked — the error is logged, not raised. The run still fails, but the row that would
  have blocked the next `up()` was never written. In practice the database has to fail twice, in
  a specific order; it matters when reading logs after an incident, because a successful
  `up()` shortly after a failed one is not by itself proof that the failure was resolved.
- **`down()` does not clear it.** A failed row is not applied, so a rollback simply steps around
  it — and warns, because the connection stays blocked afterwards. Clear *every* failed row: the
  block trips on the first one it finds, so resolving one of two changes nothing.

`resolve()` reaches registered migrations only. If the failed migration's class has been deleted,
delete its row from the tracking table by hand instead.

### Interrupted runs

A failed migration is one the ORM watched fail. An **interrupted** one is a migration whose
process was killed before it could record anything at all — OOM, `SIGKILL`, a node that went
away, a connection that dropped and took the failure write with it.

Its row is what `up()` wrote on the way in and nothing ever closed: `StartedAt` set, `FinishedAt`
`NULL`, `Logs` `NULL`. That is not the failed state (`Logs` is empty) and it is not applied
(`FinishedAt` is empty), so it counts as **pending** and the next `up()` re-runs the migration
from the top — which is very often the right thing, and sometimes is not:

- under `Transaction.Mode` `PerMigration` or `PerRun`, whatever the killed attempt had done was
  unwound with its transaction. Re-running is exactly correct.
- under `None` — **the default** — nothing was unwound. Idempotent DDL is fine. Non-idempotent
  DDL fails on the re-run and lands in the failed state, which is recoverable and loud.
  Non-idempotent **data** changes are the dangerous case: the `INSERT`s that got through are
  still there, and the re-run applies them a second time, silently.

The lock does not help here. It guards against a *concurrent* run, and this is the same run
happening twice, minutes or days apart.

So the state is reported rather than acted on:

- `status()` sets `interrupted: true` on the entry, and `spinajs migrate-status` prints the row as
  `INTERRUPTED` with a `??` marker and the two `migrate-resolve` invocations under the table.
- `up()` logs a warning naming the migration before it re-runs it.
- `resolve(name, 'applied' | 'rolled-back')` accepts such a row, so there is a lever: `'applied'`
  when you have checked and the change is in the database, `'rolled-back'` when it is not.

It deliberately does **not** block. The row records that a run *started*, not that anything
reached the database, and turning "unknown" into "refuse to migrate" would stop every boot after
every OOM kill — including the majority of cases where re-running is correct and nothing is
wrong. The failed state is for what the ORM knows went wrong; this is for what nobody knows.

**"Nobody is running it" is decided from the lock row**, which `up()` holds for the length of a
run and drops in a `finally`. A row younger than `Migration.Lock.StaleAfter` (default 10 minutes)
means a run really is in flight, and an open tracking row then belongs to it — `interrupted` stays
false. Freshness rather than mere presence, because a killed process leaves its lock row behind
too. Two consequences:

- for up to `StaleAfter` after a crash, `status()` still reports the row as an ordinary `pending`.
  That is the same window in which a restarted process waits for the lock rather than stealing it.
- with `Migration.Lock.Enabled: false` there is no signal at all, so every open row reads as
  interrupted. Right for the crash, wrong only for a report taken while a run is in progress.

### Fake runs

`{ fake: true }` writes — or removes — the tracking row without executing the migration. It
exists for baselining: a database that was brought to its current shape by other means (a hand-run
SQL script, a dump restored from another system, a migration history that predates spinajs) needs
the tracking table told so, not the migrations re-run against a schema that already has them.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function baseline() {
  const orm = await DI.resolve(Orm);

  // Records every pending migration as applied, in one batch, without running any of them.
  await orm.Migration.up(undefined, { fake: true });

  // The inverse: drops the last batch's rows without calling any down().
  await orm.Migration.down(undefined, { fake: true });
}
```

A faked `up()` still stamps `Checksum` and a batch number, so the row is indistinguishable from a
real one afterwards — which is the point. Nothing is wrapped in a transaction, because nothing is
executed.

### Checksums

`Checksum` is the sha256 of the migration class source, recorded when the migration is applied
and compared on every later run. `status()` reports the comparison as `checksumMismatch`.

It is **advisory and never blocks.** Transpilation moves the checksum as readily as an edit does
— a class built by a different TypeScript version, target or minifier produces different source
text for identical behaviour — so a hard block would false-positive across build environments and
be turned off within a week. A mismatch is logged as a warning and the run continues.

Read it as "somebody may have edited a migration that is already applied", and check. Editing an
applied migration is the mistake it is looking for: the tracking row keeps it from re-running, so
the change silently never reaches any database that already has the old version. Write a new
migration instead.

### Transaction modes

`Migration.Transaction.Mode`, a `MigrationTransactionMode`:

| Mode | Wraps |
| --- | --- |
| `None` | Nothing. **The default.** |
| `PerMigration` | Each migration in its own transaction. |
| `PerRun` | One transaction around the whole per-connection run. |

A migration can opt out with a `transaction = false` **instance** property — which is why the run
resolves every pending migration up front, before it can decide how to wrap anything. (A
prototype getter or a static of the same name is honoured too, for a migration that must opt out
without being constructed.) Under `PerRun` the opt-out splits the run into segments: the
migrations before it share one transaction, it runs bare, and the ones after it share the next.
Under `PerMigration` it simply runs unwrapped.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class RebuildOrderIndex_2026_07_27_19_00_00 extends OrmMigration {
  /**
   * An instance field, read off the constructed migration — which is why the runner resolves
   * every pending migration before it decides how to wrap the run.
   */
  public transaction = false;

  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('CREATE INDEX idx_orders_total ON orders (Total)');
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('DROP INDEX idx_orders_total');
  }
}
```

**Transaction modes genuinely protect DML, not DDL.** MySQL commits implicitly on every DDL
statement, so a `CREATE TABLE` inside a `PerRun` transaction is already committed by the time a
later migration in the same segment fails — the rollback unwinds the data changes and leaves the
schema changes standing. Treat the modes as protection for data migrations, and rely on the
failure row plus `resolve` for schema ones.

### Locking

A run claims the single row of `<table>_lock` by `INSERT` — `Id` is unique, so the database picks
the winner in one statement rather than a read-then-write that two processes could both pass. The
row carries `AcquiredAt` and an `Owner` of `hostname:pid`, so a blocked run can say who is
holding it. The release is unconditional and lives in a `finally`.

| Config | Default | Meaning |
| --- | --- | --- |
| `Migration.Lock.Enabled` | `true` | Set false to skip locking entirely. |
| `Migration.Lock.Timeout` | `30000` | Milliseconds to wait for the lock before failing. |
| `Migration.Lock.StaleAfter` | `600000` | Milliseconds after which a held lock is treated as abandoned. |

**What this lock is for: a process that crashed mid-run.** Nothing else will ever clear that
row, so a lock older than `StaleAfter` is deleted and the run retries — at most three times per
acquire, because a `DELETE` can succeed and remove nothing, and an uncapped stale branch would
warn and retry forever. A steal is logged loudly: the other reading of a lock that outlasted
`StaleAfter` is a genuinely long run that is still going, and then two migration runs are in
flight and somebody has to know.

**What this lock is not: a multi-writer guarantee.** Concurrently migrating the same database
from several processes is out of scope for this ORM — do not design a deployment around it.
Staleness is judged against the *client* clock (`AcquiredAt` is written as the migrating host's
`new Date()` and compared to that host's `Date.now()`), which is sound for the crash-and-restart
case it exists for, but skewed clocks across hosts steal too early or wait too long.

Two calls deliberately never take the lock: `status()`, because a read-only report must not block
behind a running migration, and `resolve()`, because it is the recovery path used precisely when
a run died while holding it.

If a release fails, the error is logged rather than thrown — the migration error is what the
operator needs, and the likeliest cause of a failed release is the same dead connection that
killed the run. The lock is left to go stale, or its row is deleted by hand.

### Writing a custom migration service

`OrmMigrationService` is the per-connection execution contract — everything that touches a
database during a migration run lives there, while `MigrationRunner` only orders the registry and
groups it by connection. Selecting an implementation per connection is the extension point for
dialect-specific behaviour: an advisory lock the dialect has natively, a differently shaped
tracking table, an audit trail.

| Method | Must |
| --- | --- |
| `ensureStorage()` | Create or upgrade the tracking tables this connection needs. |
| `up(units, options?)` | Apply the pending ones, and return the instances that ran. |
| `down(units, options?)` | Roll back, and return the instances that ran. |
| `status(units)` | One `IMigrationStatusEntry` per unit. |
| `resolve(name, action, unit?)` | Force a failed or interrupted migration's recorded state. |

`units` arrives already validated, ordered and filtered to this connection. `DefaultMigrationService`
is the built-in implementation, and subclassing it is the usual path — extending
`OrmMigrationService` directly means writing all five methods.

`DefaultMigrationService.applied()` returns the raw rows that finished and were not rolled back.
It is a helper on that class, **not** part of the contract: nothing in the ORM calls it, because
everything that asks "what is applied?" needs the registry merged in and goes through `status()`.

```ts sample
import { DI } from '@spinajs/di';
import { DefaultMigrationService, IMigrationDownOptions, IMigrationUnit, OrmMigration } from '@spinajs/orm';

export class AuditedMigrationService extends DefaultMigrationService {
  public async ensureStorage(): Promise<void> {
    await super.ensureStorage();

    // `createTableIfAbsent` is inherited: it tolerates another process winning the race.
    await this.createTableIfAbsent('migration_audit', (t) => {
      t.increments('Id');
      t.string('Migration', 255).notNull();
      t.dateTime('At').notNull();
    });
  }

  public async down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]> {
    const rolledBack = await super.down(units, options);

    for (const m of rolledBack) {
      await this.driver.insert().into('migration_audit').values({ Migration: m.constructor.name, At: new Date() });
    }

    return rolledBack;
  }
}

// Migration.Service on the connection names this token.
DI.register(AuditedMigrationService).as('migration-service-audited');
```

```ts
// ...and in the connection's configuration:
Migration: {
  Service: 'migration-service-audited',
}
```

`this.driver` is the connection the service was constructed for; `Migration.Service` absent means
`DefaultMigrationService`. See [02-configuration.md](02-configuration.md) for the whole
`Migration` key.

### The command line

[`@spinajs/orm-cli`](../../orm-cli/README.md) wraps this facade in five commands —
`migrate-up`, `migrate-down`, `migrate-status`, `migrate-resolve` and `migrate-create` — with
operator-facing wording and exit codes suitable for a deploy gate. Its README documents the
options, the exit codes and one example per command; everything on this page about what a run
*means* applies unchanged there.

Every one of those commands resolves its Orm with `MigrateOnStartup: false`, so the act of
running a command never migrates anything: what a command does is what it says on the tin, and
nothing else. The consequence to know is the one above — a migration applied by the CLI never
gets its `data()` hook.

## The schema builder

`connection.schema()` returns a `SchemaQueryBuilder`.

| Method | Returns |
| --- | --- |
| `createTable(name, cb)` | `TableQueryBuilder` |
| `alterTable(name, cb)` | `AlterTableQueryBuilder` |
| `dropTable(name, schema?)` | `DropTableQueryBuilder` |
| `dropView(name, schema?)` | `DropViewQueryBuilder` |
| `cloneTable(cb)` | `CloneTableQueryBuilder` |
| `tableExists(name, schema?)` | `Promise<boolean>` |
| `createDatabase(name, cb?)` | `CreateDatabaseQueryBuilder` |
| `dropDatabase(name)` | `DropDatabaseQueryBuilder` |
| `event(name)` / `dropEvent(name)` | `EventQueryBuilder` / `DropEventQueryBuilder` |
| `raw(query, bindings?)` | `RawSchemaQueryBuilder` |

Every builder is thenable — `await` it to run it.

## Creating and dropping a database

```typescript
await connection.schema().createDatabase('yourscreen-db').ifNotExists().charset('utf8mb4').collation('utf8mb4_unicode_ci');
// CREATE DATABASE IF NOT EXISTS `yourscreen-db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci

await connection.schema().dropDatabase('yourscreen-db').ifExists();
// DROP DATABASE IF EXISTS `yourscreen-db`
```

The options can also be set from a callback, `createDatabase('db', (d) => d.ifNotExists())`.

Charset and collation names are not quotable identifiers and cannot be bound as parameters, so
they are validated instead: anything outside `[A-Za-z0-9_]` is rejected with an `InvalidArgument`
rather than interpolated into the statement.

Per driver:

- **MySQL** — as above.
- **MSSQL** — no `CHARACTER SET` (`charset()` throws, collation carries both), and since T-SQL
  forbids `CREATE DATABASE` anywhere but alone in its batch, `ifNotExists()` compiles to
  `IF DB_ID('db') IS NULL EXEC('CREATE DATABASE [db]')`.
- **SQLite** — has no server-side database, so both statements throw `NotSupported`; a database
  is the file the connection was opened on.

## Creating a table

### Column types

Each `ColumnType` value becomes a method on `TableQueryBuilder`, installed onto the prototype at
module load.

| Group | Methods |
| --- | --- |
| Integers | `tinyint` `smallint` `mediumint` `int` `bigint` |
| Text | `tinytext` `text` `mediumtext` `longtext` `string(name, length?)` |
| Numeric | `float(name, precision?, scale?)` `double(...)` `decimal(...)` |
| Boolean | `boolean` `bit` |
| Temporal | `date` `time` `dateTime` `timestamp` |
| Structured | `enum(name, values)` `json` `set(name, allowed)` |
| Binary | `binary(name, size)` `tinyblob` `mediumblob` `longblob` |

Two shorthands:

- `increments(name)` — `int(name).autoIncrement().notNull().primaryKey()`
- `uuid(name)` — `binary(name, 16)`, matching what `UuidConverter` writes

### Column modifiers

Every column method returns a `ColumnQueryBuilder`:

`notNull()` `unique()` `unsigned()` `autoIncrement()` `primaryKey()` `comment(text)`
`charset(cs)` `collation(c)` `default()`.

`default()` returns a `DefaultValueBuilder` with `value(v)`, `date()`, `dateTime()` and
`raw(query)`.

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQuery } from '@spinajs/orm';

@Migration('default')
export class CreateProducts_2026_07_27_11_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('products', (table) => {
      table.increments('Id');
      table.uuid('PublicId').notNull().unique();

      table.string('Sku', 64).notNull().unique().comment('Stock keeping unit');
      table.string('Name', 255).notNull();
      table.text('Description');

      table.decimal('Price', 12, 2).notNull().unsigned();
      table.int('Stock').notNull().unsigned().default().value(0);

      table.enum('Status', ['draft', 'live', 'retired']).notNull().default().value('draft');
      table.set('Tags', ['new', 'sale', 'clearance']);
      table.json('Attributes');

      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('UpdatedAt');
      table.dateTime('DeletedAt');

      table.string('Slug', 255).default().raw(RawQuery.create("''"));

      table.comment('Catalogue products');
      table.charset('utf8mb4');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('products');
  }
}
```

### Table-level options

| Method | Effect |
| --- | --- |
| `ifExists()` | Emit `IF NOT EXISTS` semantics for the create. |
| `temporary()` | Create a temporary table. |
| `trackHistory()` | Turn on history tracking — every change and row is versioned, readable through `@Historical` and `IHistoricalModel`. |
| `comment(text)` | Table comment. |
| `charset(cs)` | Table charset. |

### Composite primary keys

Mark each key column with `primaryKey()`. Dialects that cannot express a composite key inline —
SQLite — clear `InlinePrimaryKey` on the column builders and emit a table-level constraint
instead. That is handled for you.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class CreateTenantRecords_2026_07_27_12_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('composite_table', (table) => {
      table.int('TenantId').notNull().primaryKey();
      table.string('Code', 32).notNull().primaryKey();
      table.string('Name', 128).notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('composite_table');
  }
}
```

## Foreign keys

`table.foreignKey(column)` returns a `ForeignKeyBuilder`.

| Method | Effect |
| --- | --- |
| `references(table, column)` | The parent table and column. |
| `onDelete(action)` | `ReferentialAction`. |
| `onUpdate(action)` | `ReferentialAction`. |
| `cascade()` | `onDelete(Cascade)` + `onUpdate(Cascade)`. |

`ReferentialAction`: `Cascade`, `SetNull`, `Restrict`, `NoAction` (default), `SetDefault`.

```ts sample
import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

@Migration('default')
export class CreateOrderItems_2026_07_27_13_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('order_items', (table) => {
      table.increments('Id');
      table.int('order_id').notNull();
      table.int('product_id');

      table.foreignKey('order_id').references('orders', 'Id').cascade();
      table.foreignKey('product_id').references('products', 'Id').onDelete(ReferentialAction.SetNull);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('order_items');
  }
}
```

## Indexes

Indexes come from the connection, not the table builder.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class IndexOrders_2026_07_27_14_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.index().name('idx_orders_client').table('orders').columns(['client_id']);

    await connection.index().name('uq_orders_reference').table('orders').columns(['Reference']).unique();
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // Drop through raw SQL — there is no dropIndex builder.
  }
}
```

## Altering a table

`AlterTableQueryBuilder` exposes the same column-type methods, each returning an
`AlterColumnQueryBuilder` with three modes.

| Method | Effect |
| --- | --- |
| `addColumn()` | Add the column. **The default.** |
| `modify()` | Change the existing column's definition. |
| `rename(newName)` | Rename it. |
| `after(column)` | Position it. |

Plus, on the table builder itself: `rename(newTableName)` and `dropColumn(column)`.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class AlterProducts_2026_07_27_15_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('products', (table) => {
      table.string('Barcode', 32).addColumn().after('Sku');
      table.string('Name', 512).modify();
      table.string('Description').rename('LongDescription');
      table.dropColumn('Obsolete');
    });

    await connection.schema().alterTable('products', (table) => {
      table.rename('catalogue_products');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('catalogue_products', (table) => {
      table.rename('products');
    });
  }
}
```

`AlterTableQueryBuilder.toDB()` returns an **array** of compiled statements — most dialects need
one statement per alteration.

## Dropping and cloning

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class Housekeeping_2026_07_27_16_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('legacy_orders');
    await connection.schema().dropView('v_legacy').ifExists();

    // Structure only.
    await connection.schema().cloneTable((clone) => {
      clone.shallowClone('orders', 'orders_backup');
    });

    // Structure plus a filtered subset of the data.
    await connection.schema().cloneTable((clone) => {
      void clone.deepClone('orders', 'orders_2026', (query) => {
        query.where('CreatedAt', '>', '2026-01-01');
      });
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('orders_backup').ifExists();
    await connection.schema().dropTable('orders_2026').ifExists();
  }
}
```

`deepClone` is `async` and returns a promise of the builder; `void`-ing it inside a synchronous
callback, as above, is the usual shape.

Truncation lives on the driver and on the model, not on the schema builder:
`connection.truncate('table')` or `Model.truncate()`.

## Database events

Scheduled jobs inside the database engine. Only dialects whose `supportedFeatures().events` is
true support them — **MySQL and MSSQL do; SQLite does not.**

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQueryStatement } from '@spinajs/orm';

@Migration('default')
export class ScheduleCleanup_2026_07_27_17_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    const event = connection.schema().event('purge_old_sessions');

    event.every().hour(1);
    event.comment('Delete sessions older than a day');
    event.do(connection.del().from('sessions').where('CreatedAt', '<', '2026-01-01'));

    await event;
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().dropEvent('purge_old_sessions');
  }
}
```

`EventQueryBuilder`:

| Method | Effect |
| --- | --- |
| `every()` | Returns an `EventIntervalDesc` — `second`, `minute`, `hour`, `month`, `year`. Repeats. |
| `fromNow()` | Same shape, but runs once at `now + interval`. |
| `at(dateTime)` | Run once at a specific luxon `DateTime`. |
| `do(sql)` | A `RawQueryStatement`, one `QueryBuilder`, or an array of them. |
| `comment(text)` | Documentation, passed to the engine. |

`ScheduleQueryBuilder` wraps the same thing with `create(name, cb)` and `drop(name)`.

## Raw DDL

For anything the builders do not cover.

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQuery } from '@spinajs/orm';

@Migration('default')
export class RawDdl_2026_07_27_18_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('CREATE VIEW v_active_orders AS SELECT * FROM orders WHERE Status = ?', ['open']);

    await connection.schema().raw(RawQuery.create('CREATE INDEX idx_orders_status ON orders (Status)'));
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropView('v_active_orders').ifExists();
  }
}
```

## Reflecting an existing schema

`driver.tableInfo(name, schema?)` returns `IColumnDescriptor[]`. `Orm.resolve()` calls it for
every model — it is what makes decorator-free properties into real columns.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function reflect() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  const exists = await driver.schema().tableExists('orders', driver.Options.Database);
  const columns = exists ? await driver.tableInfo('orders', driver.Options.Database) : [];

  return columns.map((c) => ({
    name: c.Name,
    type: c.Type,
    native: c.NativeType,
    nullable: c.Nullable,
    key: c.PrimaryKey,
  }));
}
```

## Model JSON schema

After reflection, each descriptor's `Schema` holds a JSON schema built by
`buildModelJsonSchema`. `Ignore` columns are excluded and relations omitted; a column is
`required` when it is neither nullable nor auto-increment.

| SQL type | JSON schema |
| --- | --- |
| `tinyint` `smallint` `mediumint` `int` `bigint` | `{ type: 'integer' }` |
| `decimal` `float` `double` `bit` | `{ type: 'number' }` |
| `boolean` | `{ type: 'boolean' }` |
| `date` | `{ type: 'string', format: 'date' }` |
| `dateTime` `timestamp` | `{ type: 'string', format: 'date-time' }` |
| `json` | `{ type: 'object' }` |
| `set` | `{ type: 'array', items: { type: 'string' } }` |
| anything else | `{ type: 'string' }` |

A column carrying `BooleanValueConverter` is forced to `boolean`. String columns gain
`maxLength` from `MaxLength`, `description` from `Comment`, and `nullable: true` when nullable.

```ts sample
import { Connection, Model, ModelBase, Primary, buildModelJsonSchema } from '@spinajs/orm';

@Connection('default')
@Model('products')
export class Product extends ModelBase<Product> {
  @Primary()
  public Id: number;

  public Sku: string;
}

export function schema() {
  const descriptor = Product.getModelDescriptor();

  // Already built during Orm.resolve(); rebuild it explicitly if you changed the columns.
  return { stored: descriptor.Schema, rebuilt: buildModelJsonSchema(descriptor) };
}
```

## Writing migrations that survive

- **Do not import models into `up()`.** They are not wired yet. Use `data()` — and remember it
  runs only for migrations applied by `Orm.resolve()`'s own boot pass.
- **Make `data()` safe to run twice, and never assume it ran at all.** It is skipped for anything
  the CLI applied, and it is lost outright for every migration of a boot run that failed before
  reaching the phase — the schema is recorded applied, so no later boot will retry the seed. See
  the note under [the three hooks](#the-three-hooks).
- **Never edit an applied migration.** The recorded row keeps it from re-running, so the edit
  silently never reaches any database that already has the old version. `Checksum` will warn
  about it and nothing more. Write a new migration.
- **`down()` is not optional** — `orm.Migration.down()` calls it, and an empty `down()` deletes
  the tracking row while leaving the schema in place, which is a lie the next `up()` acts on.
- **Guard dialect-specific features** with `connection.supportedFeatures()`.
- **Timestamps order execution**, not file names or discovery order.
- **Do not lean on transaction modes for DDL.** MySQL commits implicitly on DDL; a failed run
  leaves the schema changes standing. `status()` and `resolve()` are the recovery path.
- **Fix a failed migration before anything else.** Its row blocks every later `up()` on that
  connection until `resolve()` records what actually happened.

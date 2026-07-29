# ORM migration service extraction — design

Date: 2026-07-28
Status: approved (user, 2026-07-28); amended after TypeORM/Prisma comparison (user-approved amendments, 2026-07-28)
Scope: `@spinajs/orm` (core), **new package `@spinajs/orm-cli`**, test updates in `orm`, `orm-sqlite`, `orm-mysql`, `orm-mssql`, `queue`; docs updates in `packages/orm/docs`.

## Problem

Migration execution lives inside the `Orm` class (`packages/orm/src/orm.ts`): `migrateUp`, `migrateDown` and the private `executeAvaibleMigrations` mix discovery, ordering, state tracking, transaction policy and execution in one place. It cannot be replaced or customized per connection, and the current implementation has known gaps:

1. No batch tracking — `migrateDown()` without a name reverses **every** applied migration.
2. No concurrency guard — two app instances booting simultaneously both run migrations.
3. Weak failure semantics — a failed `up()` leaves no trace in the tracking table; a `data()` throw during boot fails the whole ORM resolve after schema rows were already recorded and silences sibling `data()` hooks.
4. Sort comparator never returns 0 — equal timestamps are ordered by import order (non-deterministic across refactors).
5. No operational tooling — no CLI, no status introspection, no way to baseline an existing database or unblock a failed migration.
6. Minor: `migrateDown` returns `void` while `migrateUp` returns the applied list; stale doc comment claims the default table is `spinajs_orm_migrations` (actual: `spinajs_migration`); `executeAvaibleMigrations` typo; test config uses `Startup` instead of `OnStartup`.

## Decisions (user-approved)

- Extract migration functionality into a separate, DI-injectable service, configurable **per DB connection**, defaulting to the built-in implementation when not configured.
- Fix all gap groups in this refactor: batch tracking + rollback-last-batch, concurrency lock, transaction/failure hardening, minor fixes.
- **Breaking change:** remove `Orm.migrateUp` / `Orm.migrateDown`. No deprecation facade.
- Migration discovery stays pure DI (`__migrations__` via the `@Migration` decorator). Confirmed: no file-based resolution exists anywhere for migrations; this stays so, guarded by a regression test.
- Architecture option A: per-connection service + cross-connection facade (`orm.Migration`).
- Amendments after comparing TypeORM (typeorm.io/docs/migrations/*) and Prisma Migrate (prisma.io/docs/orm/prisma-migrate/*):
  - Prisma-style tracking columns: `Checksum`, `StartedAt`, `FinishedAt`, `RolledBackAt`, `Logs` — full failure-state machine with a `resolve` API.
  - Fake apply/rollback (TypeORM `--fake`, Prisma `migrate resolve --applied` baseline workflow).
  - Per-migration transaction opt-out (TypeORM `transaction = false` class property).
  - Rich `status()` plus a CLI command set in a new `@spinajs/orm-cli` package.
  - Transaction default stays `None` (TypeORM defaults to whole-batch; switching our default would silently change behavior of existing deployments).

## Architecture

Two new units inside `@spinajs/orm` (flat file layout, matching the package style) plus one new package:

### `packages/orm/src/migration-service.ts`

- `OrmMigrationService` — abstract, per-connection contract. Constructed with the connection's `OrmDriver`. Responsibilities:
  - `ensureStorage()` — create the tracking table if missing; upgrade an existing table (add missing columns, backfill).
  - `up(migrations, options)` / `down(migrations, options)` — execute given ordered migration units on this connection: gate on recorded state, instantiate via `driver.Container.resolve(type, [driver])`, apply transaction policy, maintain tracking rows (including failure state), stamp batch. Return executed `OrmMigration[]`.
  - `status(migrations)` — merge the registered list with tracking rows into `IMigrationStatusEntry[]`.
  - `resolve(name, action)` — unblock a failed or interrupted migration (`'applied'` | `'rolled-back'`).
  - `acquireLock(options)` / `releaseLock(lock)` — concurrency guard hooks.
  - **Amended 2026-07-29:** `applied()` (`IMigrationRecord[]`) was specified as part of this contract and shipped as an abstract method with no production caller — `status()` is what the runner, the CLI and every deploy gate use, because they all need the registry merged in. Every custom `Service` had to implement a method nothing would ever call, so it was dropped from the abstract contract and kept as a concrete helper on `DefaultMigrationService`.
- `DefaultMigrationService extends OrmMigrationService` — built-in implementation (behavior below).
- Shared consts move here: `MIGRATION_TABLE_NAME`, lock defaults.
- New types: `IMigrationRecord`, `IMigrationStatusEntry`, option interfaces.

### `packages/orm/src/migration-runner.ts`

- `MigrationRunner` — cross-connection orchestrator, exposed as `orm.Migration`. Constructed with the `Orm` instance (registry + connections + container). Responsibilities:
  - Validate class-name format (regex `/(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/`, luxon parse) — moved from `Orm.getMigrationDate`.
  - Order migrations by `(timestamp, name)` — deterministic tie-break, comparator returns 0 on full equality.
  - Group by target connection (from `MIGRATION_DESCRIPTION_SYMBOL` descriptor); warn and skip when the connection does not exist.
  - Apply the `Migration.OnStartup` / `force` gate (unchanged semantics: public calls default `force = true`; boot passes `force = false`).
  - Resolve the connection's service: `driver.Container.resolve(driver.Options.Migration?.Service ?? DefaultMigrationService, [driver])`. `Service` is a DI token string registered by the consumer.
  - Delegate to the service, aggregate results across connections (boot uses the executed list for the `data()` phase).

### `packages/orm-cli` (new package `@spinajs/orm-cli`)

Follows the `@spinajs/email` CLI pattern: commands in `src/cli/`, `@Command`/`@Option` decorators, `CliCommand` base, `LazyInject`-ed services. Depends on `@spinajs/orm` + `@spinajs/cli`; orm core gains **no** cli dependency. Commands:

| Command | Behavior |
| --- | --- |
| `migrate-up [name]` | `orm.Migration.up(name)`. `--fake` records without executing. `--connection <name>` limits to one connection. |
| `migrate-down [name]` | `orm.Migration.down(name)`. `--all` full teardown, `--fake`, `--connection`. |
| `migrate-status` | Prints per-migration table: name, connection, state (applied / pending / failed / rolled-back), batch, timestamps, checksum mismatch flag. Exit code 1 when pending or failed exist (Prisma `migrate status` convention), 0 otherwise. |
| `migrate-resolve <name>` | `--applied` or `--rolled-back` (exactly one required) → `orm.Migration.resolve(name, action)`. |
| `migrate-create <name>` | Scaffolds `<Name>_<yyyy_MM_dd_HH_mm_ss>.ts` from a template (class extending `OrmMigration`, empty `up`/`down`, `@Migration('default')`), into `--dir <path>` (default `./src/migrations`). Name must be a valid TS class-name prefix. |

## Public API (breaking)

```ts
orm.Migration.up(): Promise<OrmMigration[]>                    // all pending, one new batch per connection
orm.Migration.up(name: string): Promise<OrmMigration[]>        // single migration by class name
orm.Migration.up(name?, { force?: boolean, fake?: boolean, connection?: string })  // force default true; boot passes false

orm.Migration.down(): Promise<OrmMigration[]>                  // LAST BATCH only (changed default)
orm.Migration.down(name: string)                               // single migration by class name
orm.Migration.down(undefined, { all: true })                   // previous behavior: everything, reverse order
orm.Migration.down(name?, { all?: boolean, force?: boolean, fake?: boolean, connection?: string })

orm.Migration.status(): Promise<IMigrationStatusEntry[]>
orm.Migration.resolve(name: string, action: 'applied' | 'rolled-back'): Promise<void>
```

`connection` is the facade half of the CLI's `--connection` filter (command table above). It is
resolved to an `OrmDriver` before comparison, so an alias and the connection it points at select
the same run; a name no configured connection answers to throws, exactly as an unregistered
migration name does. `status()` deliberately has no such option — narrowing the deploy gate is
how a gate comes to answer "nothing to see" about the connection that is behind.

`Orm.migrateUp` / `Orm.migrateDown` are deleted. All call sites (~60, exclusively tests plus docs) switch mechanically: `db().migrateUp()` → `db().Migration.up()`. Down-tests that assert full teardown pass `{ all: true }`.

`fake: true` maintains tracking rows (insert as applied / mark rolled back) without executing `up()`/`down()` — baselining an existing database and adopting externally-run migrations.

## Configuration

Per connection (`db.Connections[n].Migration`), all keys optional; absent config keeps current defaults:

```ts
Migration?: {
  Service?: string;        // DI token of an OrmMigrationService implementation; absent → DefaultMigrationService
  OnStartup?: boolean;     // unchanged
  Table?: string;          // unchanged; default 'spinajs_migration' (doc comment corrected)
  Transaction?: {
    Mode?: MigrationTransactionMode;   // None (default) | PerMigration | PerRun (new)
  };
  Lock?: {
    Enabled?: boolean;     // default true
    Timeout?: number;      // ms to wait for the lock, default 30_000
    StaleAfter?: number;   // ms after which a held lock is considered stale and stolen, default 600_000
  };
}
```

## Tracking table

Schema (name unchanged, default `spinajs_migration`):

| Column | Type | Notes |
| --- | --- | --- |
| `Migration` | string, unique, not null | class name |
| `CreatedAt` | datetime, not null | legacy column, kept; set on row creation |
| `StartedAt` | datetime, not null | last execution attempt start |
| `FinishedAt` | datetime, nullable | NULL + `Logs` set = **failed** |
| `RolledBackAt` | datetime, nullable | set only via `resolve('rolled-back')`; a regular `down()` deletes the row instead |
| `Logs` | text, nullable | error message + stack of the failed attempt |
| `Checksum` | string(64), nullable | sha256 of migration class source (`Class.toString()`), see below |
| `Batch` | int, not null | run counter per connection |

`ensureStorage()` upgrade path: existing table inspected via `tableInfo`; each missing column added via `alterTable`; backfill: `Batch = 1`, `StartedAt = FinishedAt = CreatedAt`, rest NULL.

**Applied-gate:** a migration counts as applied when a row exists with `FinishedAt NOT NULL AND RolledBackAt NULL`.

### Failure-state machine (Prisma-inspired)

- `up()` per migration: write/refresh row with `StartedAt = now`, `FinishedAt = NULL` → execute → on success set `FinishedAt`, `Batch`, `Checksum`; on error write `Logs` (message + stack) and **stop the run for that connection**.
- A failed row (FinishedAt NULL, Logs set) **blocks** subsequent `up()` runs on that connection with an error naming the migration and pointing at `resolve` — mirrors Prisma P3009.
- `resolve(name, 'applied')` — sets `FinishedAt = now` (schema was fixed manually); keeps `Logs` for audit.
- `resolve(name, 'rolled-back')` — sets `RolledBackAt`; migration becomes pending again, next `up()` resets the row (`StartedAt`, clears `Logs`/`RolledBackAt`) and retries.
- Regular `down()` of a successfully applied migration deletes its row (unchanged semantics).
- `PerMigration`/`PerRun` transaction modes: the tracking-row failure write happens **outside** the rolled-back transaction (separate statement after rollback), otherwise the failure record itself would roll back.

### Checksum

- sha256 hex of the migration class's runtime source: `class.toString()`. Computed on apply, stored; recomputed on every `status()`/`up()` and compared.
- Mismatch = **warn-only** (log + `checksumMismatch: true` in status). Never blocks: transpilation target differences (tsc dev vs bundled prod) legitimately change the runtime source, so a hard block would false-positive across build environments. Documented as advisory: "applied migration code changed since it ran".

## Batch tracking

- `up()` computes `batch = max(Batch) + 1` (per connection, per run); every migration applied in that run records that batch.
- `down()` with no name and no `all` resolves `max(Batch)` among applied rows and reverses only migrations recorded with it, in reverse timestamp order.

## Concurrency lock (default implementation)

- Separate single-row table `<migrationTable>_lock`: `Id` (fixed 1, unique), `AcquiredAt` datetime, `Owner` string (hostname + pid).
- Acquire: attempt insert. On unique violation: read the row; if `AcquiredAt` older than `StaleAfter`, delete and retry (steal); otherwise poll every 500 ms until `Timeout`, then throw `OrmException` describing the holder.
- The lock spans the entire per-connection run (acquired after `ensureStorage`, released in `finally`).
- Portable across sqlite/mysql/mssql by construction. Native advisory locks (MySQL `GET_LOCK`, Postgres `pg_advisory_lock` — Prisma's mechanism) are exactly what a custom `Service` token is for — not built here.
- `Lock.Enabled: false` opts out (unit tests with fake drivers).
- Comparison note: TypeORM has no locking at all; Prisma locks with a fixed 10 s timeout. Ours is configurable and survives crashed holders via `StaleAfter`.

## Transactions and failure semantics

- `MigrationTransactionMode` gains `PerRun`: the whole per-connection run (all pending migrations + their tracking rows) wraps in one `driver.transaction()`. `PerMigration` unchanged. `None` remains the default (deliberate divergence from TypeORM's `all` default — no silent behavior change for existing deployments).
- **Per-migration opt-out** (TypeORM parity): `public transaction = false` instance property on a migration class excludes it from `PerMigration`/`PerRun` wrapping (needed for non-transactional DDL like MySQL `CREATE INDEX` variants). Under `PerRun`, opted-out migrations run outside the shared transaction, in order, run split into segments.
- Documented caveat (docs, not code): MySQL DDL causes implicit commit — transaction modes genuinely protect DML/data migrations only.
- `data()` phase hardening in `Orm.resolve()`: each hook wrapped in try/catch; every hook runs; collected errors re-thrown afterwards as one aggregate `OrmException` listing the failing migrations. Boot still fails loudly, but one bad seed no longer silences its siblings.

## Determinism fix

Ordering comparator sorts by `(timestamp, name)` and returns 0 for full equality. Registration/import order no longer influences execution order.

## Explicit non-goals

- No migration **generation from model diff** (TypeORM `migration:generate` / Prisma schema diff + shadow DB). Possible later via existing `tableInfo` reflection; separate deliverable.
- No file-based migration discovery of any kind; regression test asserts discovery works purely via DI registration.
- No change to the `@Migration` decorator, name format contract, or `data()` model-availability semantics (`data()` is our seeding story — neither competitor has an in-migration post-init hook; Prisma separates `db seed`).
- No checksum hard-blocking (see rationale above).

## Minor fixes bundled

- `IDriverOptions.Migration.Table` doc comment: correct default name to `spinajs_migration`.
- `migration.test.ts` config typo `Startup` → `OnStartup`.
- `executeAvaibleMigrations` typo disappears with the extraction.
- `down` now returns the applied list (symmetry with `up`).

## Testing

Extend `packages/orm/test/migration.test.ts` (fake drivers) with:

1. Default service resolved when `Migration.Service` absent; custom DI token resolved when set.
2. Batch: two sequential `up()` runs record increasing batches; `down()` reverses only the last batch; `down({ all: true })` reverses everything.
3. Storage upgrade: existing 2-column table gets all new columns added and backfilled.
4. Lock: acquired/released around a run; contention (row present, fresh) waits then throws after `Timeout`; stale row is stolen; `Enabled: false` skips locking.
5. `PerRun` wraps the run in exactly one transaction; `transaction = false` migration excluded from wrapping.
6. Failure state: failing `up()` records `Logs` + NULL `FinishedAt`; next `up()` blocked with resolve hint; `resolve('applied')` unblocks; `resolve('rolled-back')` makes it pending and retryable.
7. Fake: `up({fake})` records without executing (spy not called); `down({fake})` removes record without executing.
8. Checksum: recorded on apply; altered class source → status reports mismatch, run only warns.
9. `data()` aggregate: two failing hooks → both sibling hooks executed, one aggregate error thrown.
10. Deterministic order: equal timestamps sort by name.
11. `down` returns executed migrations.
12. Regression: migrations discovered exclusively via DI registration (no reflection/file involvement).

`packages/orm-cli` test suite (pattern: `packages/email` cli tests): each command against sqlite in-memory — up/down/status output + exit codes, resolve both flags, create scaffolds a well-formed file with valid timestamp name.

Real-driver smoke (orm-sqlite integration): boot against a database holding an old-shape (2-column) tracking table; expect new columns added, backfill correct, boot succeeds.

Existing suites in `orm-sqlite` / `orm-mysql` / `orm-mssql` / `queue` update call sites mechanically and must stay green.

## Blast radius

- `packages/orm/src`: `orm.ts` (shrinks), `interfaces.ts` (config types, enum, doc fix), `index.ts` (new exports), new `migration-service.ts`, `migration-runner.ts`.
- New package `packages/orm-cli`: package.json, tsconfigs, `src/cli/*.ts` (5 commands), `src/index.ts`, test suite. Scaffold copied from `packages/email` layout (cli dir) + a small package as tsconfig template.
- Tests: `packages/orm/test/migration.test.ts` (rewrite/extend), mechanical call-site updates in `orm-sqlite` (13 files), `orm-mysql` (4), `orm-mssql` (1), `queue` (1).
- Docs: `packages/orm/docs/10-schema-and-migrations.md` (lifecycle, running-by-hand, new config, batches, lock, failure/resolve, fake, checksum), `02-configuration.md` (config keys), `12-architecture.md` (component list), new `packages/orm-cli/README`/docs page (commands).

## Comparison summary (TypeORM / Prisma), for the record

| Dimension | This design | TypeORM | Prisma |
| --- | --- | --- | --- |
| Rollback unit | last batch default; single; all | single per revert call | manual (diff + resolve) |
| Locking | portable lock table, configurable timeout, stale-steal | none | native advisory lock, fixed 10 s |
| Failure state | recorded + resolve API | none (row only on success) | recorded + resolve CLI |
| Fake/baseline | `fake` option | `--fake` | `resolve --applied` |
| Transactions | None default; PerMigration/PerRun; per-class opt-out | `all` default; each/none; per-class override | per-dialect, not configurable |
| Seeding | `data()` hook, models available | none | separate `db seed` |
| Extensibility | per-connection service via DI | none | none (closed engine) |

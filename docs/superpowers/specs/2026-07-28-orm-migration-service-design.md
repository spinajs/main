# ORM migration service extraction — design

Date: 2026-07-28
Status: approved (user, 2026-07-28)
Scope: `@spinajs/orm` (core), test updates in `orm`, `orm-sqlite`, `orm-mysql`, `orm-mssql`, `queue`; docs updates in `packages/orm/docs`.

## Problem

Migration execution lives inside the `Orm` class (`packages/orm/src/orm.ts`): `migrateUp`, `migrateDown` and the private `executeAvaibleMigrations` mix discovery, ordering, state tracking, transaction policy and execution in one place. It cannot be replaced or customized per connection, and the current implementation has known gaps:

1. No batch tracking — `migrateDown()` without a name reverses **every** applied migration.
2. No concurrency guard — two app instances booting simultaneously both run migrations.
3. Weak failure semantics — a `data()` throw during boot fails the whole ORM resolve after schema rows were already recorded; sibling `data()` hooks never run.
4. Sort comparator never returns 0 — equal timestamps are ordered by import order (non-deterministic across refactors).
5. Minor: `migrateDown` returns `void` while `migrateUp` returns the applied list; stale doc comment claims the default table is `spinajs_orm_migrations` (actual: `spinajs_migration`); `executeAvaibleMigrations` typo; test config uses `Startup` instead of `OnStartup`.

A production CLI is a separate, later deliverable and is **out of scope** here, but the service API must be sufficient for it (hence `status()`).

## Decisions (user-approved)

- Extract migration functionality into a separate, DI-injectable service, configurable **per DB connection**, defaulting to the built-in implementation when not configured.
- Fix all four gap groups in the same refactor (batch tracking + rollback-last-batch, concurrency lock, transaction/failure hardening, minor fixes).
- **Breaking change:** remove `Orm.migrateUp` / `Orm.migrateDown`. No deprecation facade.
- Migration discovery stays pure DI (`__migrations__` via the `@Migration` decorator). Confirmed: no file-based resolution (`ResolveFromFiles`) exists anywhere for migrations; this stays so, guarded by a regression test.
- Architecture option A: per-connection service + cross-connection facade (`orm.Migration`).

## Architecture

Two new units inside `@spinajs/orm` (flat file layout, matching the package style):

### `packages/orm/src/migration-service.ts`

- `OrmMigrationService` — abstract, per-connection contract. Constructed with the connection's `OrmDriver`. Responsibilities:
  - `ensureStorage()` — create the tracking table if missing; upgrade an existing table (add `Batch` column, backfill `1`).
  - `applied()` — list recorded migrations (`IMigrationRecord[]`).
  - `up(migrations, options)` / `down(migrations, options)` — execute given ordered migration units on this connection: compute pending/applied gate, instantiate via `driver.Container.resolve(type, [driver])`, apply transaction policy, record/delete tracking rows, stamp batch. Return executed `OrmMigration[]`.
  - `status(migrations)` — merge the registered list with tracking rows.
  - `acquireLock(options)` / `releaseLock(lock)` — concurrency guard hooks.
- `DefaultMigrationService extends OrmMigrationService` — built-in implementation (behavior below).
- Shared consts move here: `MIGRATION_TABLE_NAME`, lock defaults.
- New types: `IMigrationRecord { Migration, CreatedAt, Batch }`, `IMigrationStatusEntry { name, connection, applied, batch, createdAt }`, option interfaces.

### `packages/orm/src/migration-runner.ts`

- `MigrationRunner` — cross-connection orchestrator, exposed as `orm.Migration`. Constructed with the `Orm` instance (registry + connections + container). Responsibilities:
  - Validate class-name format (regex `/(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/`, luxon parse) — moved from `Orm.getMigrationDate`.
  - Order migrations by `(timestamp, name)` — deterministic tie-break, comparator returns 0 on full equality.
  - Group by target connection (from `MIGRATION_DESCRIPTION_SYMBOL` descriptor); warn and skip when the connection does not exist.
  - Apply the `Migration.OnStartup` / `force` gate (unchanged semantics: public calls default `force = true`; boot passes `force = false`).
  - Resolve the connection's service: `driver.Container.resolve(driver.Options.Migration?.Service ?? DefaultMigrationService, [driver])`. `Service` is a DI token string registered by the consumer.
  - Delegate to the service, aggregate executed migrations across connections and return them (boot uses this for the `data()` phase).

### `packages/orm/src/orm.ts` after extraction

- Keeps: `Migrations` registry array, `registerMigration` (programmatic registration incl. name validation for the webpack case), connection creation, `data()` phase.
- Removes: `migrateUp`, `migrateDown`, `executeAvaibleMigrations`, `getMigrationDate`, `MIGRATION_TABLE_NAME`, `MIGRATION_FILE_REGEXP`.
- Adds: `public Migration: MigrationRunner` (created in `resolve()` before the boot migration run).
- Boot flow in `resolve()`: `... createConnections → register migrations/models → const executed = await this.Migration.up(undefined, { force: false }) → converters/reflection/relations/mixins → data() phase over executed`.

## Public API (breaking)

```ts
orm.Migration.up(): Promise<OrmMigration[]>                    // all pending, one new batch per connection
orm.Migration.up(name: string): Promise<OrmMigration[]>        // single migration by class name
orm.Migration.up(name?, { force?: boolean })                   // force default true; boot passes false

orm.Migration.down(): Promise<OrmMigration[]>                  // LAST BATCH only (changed default)
orm.Migration.down(name: string)                               // single migration by class name
orm.Migration.down(undefined, { all: true })                   // previous behavior: everything, reverse order
orm.Migration.down(name?, { all?: boolean, force?: boolean })

orm.Migration.status(): Promise<IMigrationStatusEntry[]>
```

`Orm.migrateUp` / `Orm.migrateDown` are deleted. All call sites (~60, exclusively tests plus docs) switch mechanically: `db().migrateUp()` → `db().Migration.up()`. Down-tests that assert full teardown pass `{ all: true }`.

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

## Batch tracking

- Tracking table schema becomes: `Migration` string unique not null, `CreatedAt` datetime not null, `Batch` int not null.
- `ensureStorage()` on an existing table inspects `tableInfo`; missing `Batch` → `alterTable` add column, backfill existing rows with `1`.
- `up()` computes `batch = max(Batch) + 1` (per connection, per run); every migration applied in that run records that batch.
- `down()` with no name and no `all` resolves `max(Batch)` and reverses only migrations recorded with it, in reverse timestamp order.

## Concurrency lock (default implementation)

- Separate single-row table `<migrationTable>_lock`: `Id` (fixed 1, unique), `AcquiredAt` datetime, `Owner` string (hostname + pid).
- Acquire: attempt insert. On unique violation: read the row; if `AcquiredAt` older than `StaleAfter`, delete and retry (steal); otherwise poll every 500 ms until `Timeout`, then throw `OrmException` describing the holder.
- The lock spans the entire per-connection run (acquired after `ensureStorage`, released in `finally`).
- Portable across sqlite/mysql/mssql by construction (plain insert/delete). Dialect-specific mechanisms (MySQL `GET_LOCK`) are exactly what a custom `Service` token is for — not built here.
- `Lock.Enabled: false` opts out (useful for unit tests with fake drivers).

## Transactions and failure semantics

- `MigrationTransactionMode` gains `PerRun`: the whole per-connection run (all pending migrations + their tracking rows) wraps in one `driver.transaction()`. `PerMigration` unchanged. `None` remains the default.
- Documented caveat (docs, not code): MySQL DDL causes implicit commit — transaction modes genuinely protect DML/data migrations only.
- `data()` phase hardening in `Orm.resolve()`: each hook wrapped in try/catch; every hook runs; collected errors re-thrown afterwards as one aggregate `OrmException` listing the failing migrations. Boot still fails loudly, but one bad seed no longer silences its siblings.

## Determinism fix

Ordering comparator sorts by `(timestamp, name)` and returns 0 for full equality. Registration/import order no longer influences execution order.

## Explicit non-goals

- No CLI in this change (service API — `status()`, batch metadata — is designed to feed it later).
- No file-based migration discovery of any kind, now or later; regression test asserts discovery works purely via DI registration.
- No change to the `@Migration` decorator, name format contract, or `data()` model-availability semantics.

## Minor fixes bundled

- `IDriverOptions.Migration.Table` doc comment: correct default name to `spinajs_migration`.
- `migration.test.ts` config typo `Startup` → `OnStartup`.
- `executeAvaibleMigrations` typo disappears with the extraction.
- `down` now returns the applied list (symmetry with `up`).

## Testing

Extend `packages/orm/test/migration.test.ts` (fake drivers) with:

1. Default service resolved when `Migration.Service` absent; custom DI token resolved when set.
2. Batch: two sequential `up()` runs record increasing batches; `down()` reverses only the last batch; `down({ all: true })` reverses everything.
3. Storage upgrade: existing 2-column table gets `Batch` added and backfilled.
4. Lock: acquired/released around a run; contention (row present, fresh) waits then throws after `Timeout`; stale row is stolen; `Enabled: false` skips locking.
5. `PerRun` wraps the run in exactly one transaction.
6. `data()` aggregate: two failing hooks → both sibling hooks executed, one aggregate error thrown.
7. Deterministic order: equal timestamps sort by name.
8. `down` returns executed migrations.
9. Regression: migrations discovered exclusively via DI registration (no reflection/file involvement).

Real-driver smoke (orm-sqlite integration): boot against a database holding an old-shape (2-column) tracking table; expect `Batch` column added, backfill = 1, boot succeeds.

Existing suites in `orm-sqlite` / `orm-mysql` / `orm-mssql` / `queue` update call sites mechanically and must stay green.

## Blast radius

- `packages/orm/src`: `orm.ts` (shrinks), `interfaces.ts` (config types, enum, doc fix), `index.ts` (new exports), new `migration-service.ts`, `migration-runner.ts`.
- Tests: `packages/orm/test/migration.test.ts` (rewrite/extend), mechanical call-site updates in `orm-sqlite` (13 files), `orm-mysql` (4), `orm-mssql` (1), `queue` (1).
- Docs: `packages/orm/docs/10-schema-and-migrations.md` (lifecycle, running-by-hand, new config, batches, lock), `02-configuration.md` (config keys), `12-architecture.md` (component list mention).

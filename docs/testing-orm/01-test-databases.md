# Test databases

```ts
import { createTestApp, type TestApp } from '@spinajs/testing';
import { createTestDatabase, type TestDatabase } from '@spinajs/testing-orm';

let db: TestDatabase;
let app: TestApp;

beforeEach(async () => {
  db = await createTestDatabase();               // PGlite, connection 'default'
  app = await createTestApp({ config: { db: { Connections: [db.config] } } });
  await db.migrate(app.container);               // the migrations and their seeds; resolves with the Orm
});

afterEach(async () => {
  await app.dispose();
  await db.dispose();                            // drops the schema
});
```

`db.config` is a plain-JSON `db.Connections` entry, so it fits `createTestApp({ config })`, a configuration class or
a config file. Call `createTestDatabase()` before creating the app, and `dispose()` after disposing it.

The app's boot never migrates: it checks the migrations and fails with `PendingMigrationsException` while one is
pending. `db.migrate(container)` runs `migrateTestDatabase(container)` from `@spinajs/orm/testing`: it applies the
pending migrations and their `data()` seeds through the migration tool of that container and resolves with its Orm,
which the app then uses. Call it after creating the app and before anything there resolves the Orm (a `resolve` list
of `createTestApp` that reaches the Orm counts).

## Strategies

**`schema` (default).** One PGlite instance per test process, created by the first call (about 2 s). Every call
returns a new schema on it (`tdb_<pid>_<random>`); `migrate()` runs the migrations in that schema, and `dispose()`
drops it. A schema costs no PGlite start, only the app boot and the migrations.

The instance has one session. Its pool hands the session to one connection at a time, in request order, and switches
`search_path` to that connection's schema first. A transaction keeps the session from `BEGIN` to `COMMIT`, so two
apps that are live at the same time in one process never interleave statements or schemas; the cost is that the other
app waits for the transaction to end (up to `Pool.AcquireTimeout`). mocha's `--parallel` runs files in separate
processes, each with its own instance. The instance closes a second after the last connection lets go of it.

**`template`.** The first call boots a throwaway app on its own PGlite, migrates it with every migration registered
at that moment (with their `data()` seeds) and dumps the database to a tarball; every app on the entry loads its own
copy (about 0.3–0.7 s). `migrate()` finds those applied and runs only migrations registered later. `configuration` gives that first boot the
app's own configuration, for seeds that read it; one template is built per configuration class.

## Speed

The program's target was a migrated database in under 100 ms. On a Windows dev box PGlite itself takes about 2 s to
start and 0.3–0.7 s to load a dump, while migrating 22 tables takes about 30 ms; that is why the default shares one
instance and creates a schema per test. `npm run bench` in `packages/testing-orm` measures both strategies, and
the `pglite` job of `orm-postgres.yml` prints the CI runner's numbers.

Measured on that box (20 tables, a test app boot and the migration run, medians of 10): a `schema` boot about 1 s,
a `template` boot about 2 s, a new PGlite per boot 4.5–6 s. Neither strategy is under 100 ms; most of a `schema` boot
is the test app's own boot and the migration run.

## Options

| Option | Default | Meaning |
|---|---|---|
| `dialect` | `'pglite'` | `'sqlite'` returns a `:memory:` connection. |
| `connection` | `'default'` | The connection name. Migrations decorated `@Migration(name)`, and `@Migration('default')` ones when it is the default connection, apply. |
| `migrate` | `true` | `false`: an empty schema whose boot does not check the migrations (`Migration.Check: 'off'`); `schema` strategy only, with `template` it is an `InvalidArgument`. |
| `strategy` | `'schema'` | `'template'`: a copy of an instance migrated once per process. |
| `configuration` | `FrameworkConfiguration` | `template` only: the configuration of the template boot. |

## Upgrading from the boot migration

Before, `db.config` carried `Migration: { OnStartup: true }` and the app's boot ran the migrations; seeds ran once the
Orm was cached. Now the entry carries no `Migration` key (`{ Check: 'off' }` with `migrate: false`), and the
migrations and seeds run when `migrate()` is called:

```ts
// before
const db = await createTestDatabase();
const app = await createTestApp({ config: { db: { Connections: [db.config] } }, resolve: [OrmMigrator] });

// now
const db = await createTestDatabase();
const app = await createTestApp({ config: { db: { Connections: [db.config] } } });
const orm = await db.migrate(app.container);
```

# Test databases

```ts
import { createTestApp, type TestApp } from '@spinajs/testing';
import { createTestDatabase, type TestDatabase } from '@spinajs/testing-orm';

let db: TestDatabase;
let app: TestApp;

beforeEach(async () => {
  db = await createTestDatabase();               // PGlite, connection 'default'
  app = await createTestApp({ config: { db: { Connections: [db.config] } } });
});

afterEach(async () => {
  await app.dispose();
  await db.dispose();                            // drops the schema
});
```

`db.config` is a plain-JSON `db.Connections` entry, so it fits `createTestApp({ config })`, a configuration class or
a config file. Call `createTestDatabase()` before creating the app, and `dispose()` after disposing it.

## Strategies

**`schema` (default).** One PGlite instance per test process, created by the first call (about 2 s). Every call
returns a new schema on it (`tdb_<pid>_<random>`); the app's boot runs the migrations in that schema, and
`dispose()` drops it. A schema costs no PGlite start, only the app boot and the migrations.

The instance has one session. Its pool hands the session to one connection at a time, in request order, and switches
`search_path` to that connection's schema first. A transaction keeps the session from `BEGIN` to `COMMIT`, so two
apps that are live at the same time in one process never interleave statements or schemas; the cost is that the other
app waits for the transaction to end (up to `Pool.AcquireTimeout`). mocha's `--parallel` runs files in separate
processes, each with its own instance. The instance closes a second after the last connection lets go of it.

**`template`.** The first call boots a throwaway app on its own PGlite, runs every migration registered at that
moment (with their `data()` seeds) and dumps the database to a tarball; every app on the entry loads its own copy
(about 0.3–0.7 s). Migrations registered later still run on the app's boot. `configuration` gives that first boot the
app's own configuration, for seeds that read it; one template is built per configuration class.

## Speed

The program's target was a migrated database in under 100 ms. On a Windows dev box PGlite itself takes about 2 s to
start and 0.3–0.7 s to load a dump, while migrating 22 tables takes about 30 ms; that is why the default shares one
instance and creates a schema per test. `npm run bench` in `packages/testing-orm` measures both strategies, and
the `pglite` job of `orm-postgres.yml` prints the CI runner's numbers.

Measured on that box (20 tables, a test app boot that runs the migrations, medians of 10): a `schema` boot about 1 s,
a `template` boot about 2 s, a new PGlite per boot 4.5–6 s. Neither strategy is under 100 ms; most of a `schema` boot
is the test app's own boot and the migration run.

## Options

| Option | Default | Meaning |
|---|---|---|
| `dialect` | `'pglite'` | `'sqlite'` returns a `:memory:` connection the app migrates itself. |
| `connection` | `'default'` | The connection name. Migrations decorated `@Migration(name)`, and `@Migration('default')` ones when it is the default connection, apply. |
| `migrate` | `true` | `false`: an empty schema (`schema` strategy only; with `template` it is an `InvalidArgument`). |
| `strategy` | `'schema'` | `'template'`: a copy of an instance migrated once per process. |
| `configuration` | `FrameworkConfiguration` | `template` only: the configuration of the template boot. |

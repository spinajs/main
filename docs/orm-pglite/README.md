# @spinajs/orm-pglite

PostgreSQL in the test process. `PgliteOrmDriver` is the postgres driver (`@spinajs/orm-postgres`) over
[PGlite](https://pglite.dev), a WASM build of PostgreSQL (`@electric-sql/pglite` 0.5.10, PostgreSQL 18.6). Queries are compiled
by the same postgres compilers production uses, so a test on PGlite checks the SQL a server would run.

## Connection

```ts
{
  Driver: 'orm-driver-pglite',
  Name: 'default',
  // optional: a data directory to keep the database in; unset or ':memory:' keeps it in memory
  Filename: ':memory:',
  Options: {
    Schema: 'app',                    // created when missing, set as search_path
    LoadDataDir: '/tmp/template.tar', // a dumpDataDir() tarball (path or Blob) to start from
    RelaxedDurability: false,
  },
}
```

Importing `@spinajs/orm-pglite` registers the driver under `orm-driver-pglite`.

## What matches a server

- Values are bound with node-postgres' own `prepareValue`, and every type is parsed by the postgres driver's own
  parsers: `int8` and `numeric` come back as strings, `date` and `timestamp` as UTC instants, `interval` as an object,
  `bytea` as a `Buffer`.
- The session runs in UTC, like every pooled session of the postgres driver.
- Errors carry the server's SQLSTATE, table, constraint and column, so `UniqueViolation` and `ConstraintViolation`
  map as on a server.

## What differs

- **One session.** The pool hands out its single client in request order. A transaction holds it from `BEGIN` to
  `COMMIT`; anything else waits, up to `Pool.AcquireTimeout`. `supportedFeatures().concurrentTransactions` is `false`,
  so outermost transactions queue. A test that needs a second, independent session (lock waits, isolation against a
  concurrent commit) needs a server.
- **No reconnect.** A failed statement is never retried on a new connection: that would be an empty database.
- **A newer PostgreSQL**: PGlite 0.5.10 runs PostgreSQL 18.6, while the CI server runs 16.6.

## Snapshots

`driver.dumpDataDir()` returns a tarball of the whole database; a connection with `Options.LoadDataDir` starts from a
copy of it. `@spinajs/testing-orm` builds its per-test databases this way.

## Running the postgres integration suite on PGlite

```bash
cd packages/orm-postgres
ORM_TEST_POSTGRES_DRIVER=pglite npm run test:integration
```

Suites that need a server (a second session, an admin session, a container restart) are listed with their reason in
`packages/orm-postgres/test/integration/pglite-mode.ts` and are skipped in this mode.

---
"@spinajs/testing-orm": minor
---

New package `@spinajs/testing-orm`. `createTestDatabase()` returns a JSON-safe `db.Connections` entry and its `migrate()` and `dispose()`: by default a new schema on one PGlite instance shared by the test process, dropped by `dispose()`; `strategy: 'template'` loads a copy of an instance migrated once per process, and `dialect: 'sqlite'` gives an in-memory sqlite connection. The app's boot never migrates: call `await db.migrate(app.container)` after creating the app and before anything there resolves the `Orm`; it applies the pending migrations and their `data()` seeds through the migration tool (`{ seed: false }` leaves the seeds out) and resolves with the `Orm` the app then uses. `migrate: false` gives an empty database whose boot does not check the registered migrations (`Migration: { Check: 'off' }`). `bench/pglite-spinup.mjs` measures both strategies.

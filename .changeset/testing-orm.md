---
"@spinajs/testing-orm": minor
---

New package `@spinajs/testing-orm`. `createTestDatabase()` returns a JSON-safe `db.Connections` entry: by default a new schema on one PGlite instance shared by the test process, migrated by the app's boot and dropped by `dispose()`; `strategy: 'template'` loads a copy of an instance migrated once per process, and `dialect: 'sqlite'` gives an in-memory sqlite connection. `bench/pglite-spinup.mjs` measures both strategies.

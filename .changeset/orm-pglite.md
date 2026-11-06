---
"@spinajs/orm-pglite": minor
---

New package `@spinajs/orm-pglite`: `PgliteOrmDriver` (`orm-driver-pglite`) runs the postgres driver against an in-process PGlite. Values are bound with pg's `prepareValue` and parsed with the postgres driver's own type parsers, the session runs in UTC, and `Options.Schema` is created and set as the search path. One session is shared in request order (`concurrentTransactions: false`), nothing reconnects, and `dumpDataDir()` / `Options.LoadDataDir` (a file path or a Blob) snapshot and restore the database.

---
"@spinajs/orm-sqlite": patch
---

`schema().tableExists(name, schema)` on SQLite now reads `` `<schema>`.sqlite_master ``; before, it ignored `schema` and answered for `main`, so it was `false` for a table only in an attached database and `true` when `main` had a table of that name. A `schema` that is not attached answers `false`, as `tableInfo()` reads it. `tableExists(name)` without a schema runs the same unqualified statement as before.

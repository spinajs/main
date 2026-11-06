---
"@spinajs/manifest": minor
"@spinajs/orm": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-mssql": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-pglite": minor
---

`SqlDialectProfile` gains two optional flags. `caseInsensitiveIdentifiers`: `migrate-diff` matches table, column and index-column names ignoring case, so a model naming `name` against a live `Name` no longer plans an `addColumn` that fails with a duplicate column; generated code keeps the model's spelling. sqlite, mysql and mssql set it; postgres and pglite do not, because their drivers quote names. `unboundedText`: a text length that a modify re-states is not `DESTRUCTIVE`; sqlite sets it. A third-party driver sets either flag in its own profile.

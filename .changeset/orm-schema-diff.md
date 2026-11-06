---
"@spinajs/orm": minor
"@spinajs/manifest": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-pglite": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-mssql": minor
---

`buildTargetSchema` and `diffSchema` compare the schema the manifest's models declare with a live database. Models may be partial: the target of a table is the union of every model mapped to it, a column no model declares is listed and never dropped, and drops happen only for a column (or a table) removed since a base manifest, on a `@Model(t, { columns: 'exhaustive' })` table, or when pruned by name.

`SqlDialectProfile` gains the optional `nativeTypes` (the families each live native type can hold) and `untrustedNullability`. Each shipped driver's `@SqlDialect` profile lists them, so `diffSchema` takes the dialect knowledge from the driver; a third-party driver adds its own.

`introspectSchema` reads the live schema and `generateMigration` turns the changes into a `@Migration` class over the schema builder; destructive steps stay commented out unless allowed.

`modify()` keeps the live default (an expression verbatim), the live length and the nullability of an inferred column; a modify that re-states a precision or a length the driver does not report is destructive. Generated string literals escape line terminators. orm-sqlite: `tableInfo()` parses `dflt_value`, so `DefaultValue` is the string or number of a literal and a `RawQuery` for an expression such as `CURRENT_TIMESTAMP`, instead of the raw SQL text; a new model no longer starts with the quoted text or `CURRENT_TIMESTAMP` as its value.

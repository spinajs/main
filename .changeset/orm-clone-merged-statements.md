---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

`SelectQueryBuilder.clone()` rebinds only its own statements to the copy. A join or where merged in from a nested relation query (a belongsTo nested in a populated relation) keeps the alias of the query it came from, so a clone of an executed populated query and a clone of a many-to-many junction query compile and return the same rows as the original.

A clone taken before the original compiles carries its populated relations: each relation is copied onto the clone and compiles into it alone, so the clone loads the same related rows and neither query writes joins or middlewares into the other. `clone()` keeps each statement's `orWhere()` connector and `whereOnJoin()` flag: a cloned `where(a).orWhere(b)` stays `OR`, and a `whereOnJoin()` condition of a populate stays in the join instead of filtering the parent rows.

Count change: `count()` and `selectCount()` drop the populated relations that have not compiled, so a count (also on a clone of a populated query) selects no relation columns and joins no relation table. Conditions inside a populate callback, a `where()` in a belongsTo populate included, no longer narrow a count; filter the root query or use `whereExist()`.

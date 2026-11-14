---
"@spinajs/authz-orm": minor
---

The relation columns of `@AccessResource` models reach the authz changelog (kind `column`). The new `ColumnChangeMiddleware` (a query middleware, order 91) reads the `@Parent`, `@Owner` and `@Relation` columns of the rows an insert, update or delete reaches, before and after the statement, and appends one row per changed column in the statement's own transaction: key `type:id#relation` (`parent` for a `@Parent` column), payload `{ model, column, old, new }` with `old`/`new` as `{ type, id }` or `null`. An update that writes no relation column logs nothing. On by default; `@AccessResource(type, { changelog: false })` or `registerAccessResource(model, type, { changelog: false })` turns it off per model, and `changeLog().covers('column', type)` then answers false for that type. Every write of an access resource now needs `authz_change_log` on the `authz` connection: run the authz-orm migrations after upgrading.

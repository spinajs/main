---
"@spinajs/exceptions": minor
"@spinajs/http": minor
"@spinajs/http-swagger": minor
"@spinajs/orm": minor
---

`@Version()` marks a model's integer version column. Every insert path, the static `Model.insert()` of seeds included, sets it to 1 (a plain object passed to the static insert keeps a version it supplies); `update()`, `destroy()`, `archive()` and unit-of-work `save()`, with or without `reload`, add `WHERE version = :old` (and `SET version = old + 1`) and throw `OptimisticLockError` when no row matched, rolling back the whole `save()` graph. A failed `save()` gives every model of the graph, versioned or not, back its column values, version and change baseline, and the models it inserted their `auto` keys. A bulk `Model.update()` increments the version and refuses a version column in its data (`InvalidArgument`); bulk destroys and orphan deletes are not versioned, an upsert leaves an existing row's version alone, and `InsertOrReplace` is refused on a versioned model. `OptimisticLockError` extends the new `ConcurrencyConflict` of `@spinajs/exceptions`, which `@spinajs/http` answers with 409.

`@spinajs/http-swagger` documents the `@KeysetQuery()` route argument of `@spinajs/orm-http` as the optional `limit`, `after` and `before` query parameters; `limit` states no maximum because the server clamps a larger one to 500.

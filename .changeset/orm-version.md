---
"@spinajs/exceptions": minor
"@spinajs/http": minor
"@spinajs/http-swagger": minor
"@spinajs/orm": minor
---

`@Version()` marks a model's integer version column. Every insert path, the static `Model.insert()` of seeds included, sets it to 1; `update()`, `destroy()` and unit-of-work `save()` add `WHERE version = :old` (and `SET version = old + 1`) and throw `OptimisticLockError` when no row matched, rolling back the whole `save()` graph. Bulk builders, orphan deletes, `archive()` and upserts are not versioned. `OptimisticLockError` extends the new `ConcurrencyConflict` of `@spinajs/exceptions`, which `@spinajs/http` answers with 409.

`@spinajs/http-swagger` documents the `@KeysetQuery()` route argument of `@spinajs/orm-http` as the optional `limit`, `after` and `before` query parameters; `limit` states no maximum because the server clamps a larger one to 500.

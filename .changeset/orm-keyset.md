---
"@spinajs/orm": minor
"@spinajs/orm-http": minor
"@spinajs/http-swagger": minor
---

`query.paginate({ orderBy, limit, after?, before? })` returns a `KeysetPage` (`items`, `next`, `previous`) using keyset predicates over the order plus the primary key, in any mix of directions. Order columns must be NOT NULL (`InvalidArgument` otherwise). Cursors are base64url JSON of the last row's order values plus a hash of the order spec, spec-checked but not signed; a malformed or foreign cursor throws `InvalidCursor` (an `InvalidArgument`, so HTTP 400). `@spinajs/orm-http` adds `KeysetPaginationDTO` and the `@KeysetQuery()` route argument, which `@spinajs/http-swagger` documents as the `limit`, `after` and `before` query parameters.

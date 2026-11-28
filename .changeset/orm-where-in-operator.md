---
'@spinajs/orm': patch
---

`where(column, 'in', values)` and `where(column, 'not in', values)` now compile exactly as `whereIn()` / `whereNotIn()`, also through `orWhere()` / `andWhere()` and with a sub-query as the value. Before, the list was bound as one parameter (`IN ?`) and every dialect refused the statement. A `RawQuery` value compiles as before; any other value that is no array and no sub-query throws `InvalidArgument`.

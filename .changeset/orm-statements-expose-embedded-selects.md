---
"@spinajs/orm": minor
---

Statements say which selects they hold. `IQueryStatement` gains two optional members: `SubQuery`, the select an `EXISTS` / `IN` statement compiles as a sub-query (`whereExist(query)`, `whereNotExists`, `whereIn(column, query)`, `whereNotIn`, and the relation forms of `whereExist`), and `nested()`, the statements a where group, a join (its callback conditions, `onStatements` and nested joins) or a `selectCondition()` column holds. `IOrmRelation` gains the optional `pendingQuery()`: the query of a to-one populate until it is folded into the owner at compile, `undefined` afterwards and for relations that run their own query. All three are read-only discovery; nothing changes in what a query compiles to or runs. Third-party statements and relations keep compiling, as the members are optional.

---
"@spinajs/orm": patch
---

A `belongsTo` that is NULL in the database stays empty under a nested populate: the row of nulls the join returns, with one nested row per relation populated under it, no longer becomes a model whose every column is null.

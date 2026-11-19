---
"@spinajs/orm": minor
---

`QueryExtension.onMerge(source, target)`, next to `onClone`: called when a select builder is folded into another one, which is what happens to the query inside a belongsTo or many-to-many `populate()` callback and to a join callback's query. It runs before the columns, sorts and conditions of the merged builder reach the target and may throw to refuse the query. `defineQueryExtension()` takes `onMerge` too. An extension that keeps state per builder uses it to refuse a query whose state would be dropped. A join callback is merged at the `join()` call, so there the state can be moved to the builder that runs instead; a `populate()` is merged when the query compiles, which for an awaited query is after `beforeQueryExecution`, so state moved there cannot be relied on to reach a query middleware. Without such an extension a merge calls nothing.

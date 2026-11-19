---
"@spinajs/orm": minor
---

`QueryExtension.onMerge(source, target)`, next to `onClone`: called when a select builder is folded into another one, which is what happens to the query inside a belongsTo or many-to-many `populate()` callback and to a join callback's query. It runs before the target changes and may throw to refuse the query. `defineQueryExtension()` takes `onMerge` too. An extension that keeps state per builder uses it to move that state to the builder that runs, or to refuse; without such an extension a merge calls nothing.

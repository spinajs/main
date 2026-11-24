---
"@spinajs/orm": minor
---

A relation list's `sync(callback?)` applies `callback`, with the builder as `this`, to every update and delete statement it builds itself, before it runs: the one-to-many orphan delete (the soft-delete stamp for a `@SoftDelete` target) and the many-to-many orphan delete of junction rows. It is not applied to the select of existing links or to the inserts. `this` is the new exported interface `IRelationSyncStatement`, the where builder of the statement; packages add their builder methods to it by declaration merging. A throw from the callback rejects `sync()` and rolls its transaction back. `sync()` without a callback is unchanged.

New export `relationSyncOf(query)`: `{ relation, owner }` for the statements a relation list's `sync()` or `update()` builds itself (the many-to-many select of existing links and the orphan update or delete), `undefined` for every other builder. It answers in the `sync()` callback and from `beforeQueryExecution` on.

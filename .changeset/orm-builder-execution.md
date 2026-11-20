---
"@spinajs/orm": minor
---

`state().execution` tells a query extension how its builder reaches the database: `{ kind: 'own' }` for a statement of its own, `{ kind: 'merged', into: 'parent' | 'junction' | 'join' }` for the query inside a belongsTo or many-to-many `populate()` callback or a join callback, which is folded into another builder and never sent, and `{ kind: 'recursive' }` for a `@Recursive` relation, whose WHERE does not reach the rows the recursion adds. The relation's descriptor comes with it. A custom relation that folds its query into another builder overrides `NativeOrmRelation.relationQueryExecution()`; code that constructs such a builder itself passes the value as the new optional last argument of `SelectQueryBuilder`'s constructor. Nothing changes for code that does not read it.

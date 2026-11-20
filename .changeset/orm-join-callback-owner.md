---
"@spinajs/orm": patch
---

The builder of a join's callbacks no longer gets its `JoinStatement` as owner. `Owner` and `state().owner` are typed `IOrmRelation | undefined`, and a join statement is not a relation: a relation populated inside a join callback took it for its parent relation. They are `undefined` there now; `state().execution` (`{ kind: 'merged', into: 'join' }`) is how such a builder is recognised.

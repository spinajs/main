---
"@spinajs/authz-ir": minor
---

`IREvaluator.expand(object, relation)` returns the userset rewrite one level deep (Zanzibar Expand), `listObjects({ principal, permission, type })` and `listSubjects(object, permission, subjectType)` enumerate candidates through the `TupleSource` and keep those `check` allows, in a stable order.

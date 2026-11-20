---
"@spinajs/orm": minor
---

The selects the ORM runs for a hasMany, many-to-many or recursive relation and for each page of a keyset `stream()` run on a `clone()` of the query. They ran on an internal copy that called no `onClone` hook, so state a query extension kept in a `WeakMap` keyed by the builder was not found by a `QueryMiddleware` on those statements. `groupWhere()` is new on the select builder: it wraps the WHERE statements a query has so far into one AND group. A field of a builder subclass that its `clone()` does not copy is no longer seen on those statements.

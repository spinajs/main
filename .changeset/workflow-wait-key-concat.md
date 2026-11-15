---
"@spinajs/workflow": patch
---

The `'*'` wait key range of the signalled-wait query is built with `whereColumn()` and `concat()` instead of a raw predicate; the SQL and its bindings are unchanged.

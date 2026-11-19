---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

A clone of a query with a join callback built the join again: both callbacks ran once more per clone, the columns the query callback selected were doubled (the extra copy compiled bare or under the outer alias, so the clone could fail with `no such column` or `ambiguous column name`), and the builder a join had been merged from gained another copy of those columns on every clone of the query it was merged into. A clone now copies the join with its own copy of the join's builder: the callbacks and `onMerge` do not run again, the clone compiles the statement of its source, and neither the source nor the builder the join came from changes.

---
"@spinajs/orm-sql": patch
---

The conditions of a join callback reach the join's `ON` clause as one parenthesised group. Before, the conditions of a join query callback (the third argument of `leftJoin()`, `innerJoin()` and the other join methods, or `queryCallback` in the join options) were appended flat after the callback's own group, so `this.orWhere(b)` there compiled to `ON pk = fk AND ( a ) OR b` and joined every target row that matched `b` to every source row. They now compile to `ON pk = fk AND ( ( a ) OR b )`. A join callback alone compiles as before.

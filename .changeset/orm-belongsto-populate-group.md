---
"@spinajs/orm": patch
---

The conditions of a belongsTo populate callback reach the parent query's WHERE as one parenthesised AND group. Before, they were appended flat, so `populate('Order', function () { this.where(a).orWhere(b) })` compiled to `WHERE <caller> AND a OR b`: the `OR` widened the parent query past the caller's own conditions and past any condition a `beforeQueryExecution` middleware had added, such as an `.accessible()` access plan. Conditions of a nested belongsTo populate end up inside the group of their parent relation. Aggregate conditions, which compile into HAVING, stay where they were. `SelectQueryBuilder.mergeStatementsAsGroup()` is new.

---
"@spinajs/audit-orm": patch
---

An aggregate in a query with a join counts for the queried table only, as its SQL names that table since #827; it no longer counts for every joined table with a column of the same name.

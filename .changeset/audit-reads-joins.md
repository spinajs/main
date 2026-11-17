---
"@spinajs/audit-orm": patch
---

Read auditing attributes each selected column to the table its table alias names, so a column that a `join()` query callback or a `populate()` callback selects under an alias of its own is audited for the joined model. A column under an alias that names no model, and a raw select expression next to a join, count as reading every audited table they could reach. A rule applies to every model of its table on its connection, junction tables included.

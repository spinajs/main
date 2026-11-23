---
"@spinajs/orm-sqlite": major
---

On SQLite, `@DateTime` (and `@CreatedAt`, `@UpdatedAt` and the other timestamp decorators) writes Unix seconds into a column declared with a numeric type in any case (`INTEGER`, `BIGINT`, `REAL`, ...), as it already did for lower-case names. What breaks: such a column that holds ISO text written before now receives numbers; convert the existing text rows before upgrading.

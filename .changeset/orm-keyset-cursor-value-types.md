---
"@spinajs/orm": patch
---

`paginate()`: a cursor value for a `time` column must be a time of day, and for a `decimal` column a number where the driver reads decimals back as numbers (SQL Server, SQLite); anything else is refused as `InvalidCursor` before any SQL runs. Before, such a forged value reached SQL Server, whose conversion error could depend on rows of other tenants. A PostgreSQL `time` of `24:00:00` and a MySQL `TIME` of 24 hours or more can no longer be paged past.

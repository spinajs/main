---
"@spinajs/orm": patch
---

`paginate()`: a cursor value for a `time` column must be a time of day, and for a `decimal` column a number where the driver reads decimals back as numbers (SQL Server, SQLite); anything else is refused as `InvalidCursor` before any SQL runs. Before, such a forged value reached SQL Server, whose conversion error could depend on rows of other tenants. An order column whose native type is `time` still cannot be paged: its value hydrates as a `TimeSpan`, which a cursor cannot hold (`InvalidOperation`), so the `time` rule judges only cursors a caller wrote.

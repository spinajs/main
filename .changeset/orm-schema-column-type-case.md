---
"@spinajs/orm": patch
---

A model's request and response schema read SQL column types in any case and without a size suffix, so SQLite columns declared `INTEGER`, `REAL` or `DECIMAL(10,2)` get a numeric type instead of `string`. `columnToSchema()` is exported with its result type `IColumnJsonSchema`.

---
"@spinajs/orm": minor
---

A model's request and response schema read SQL column types in any case and without a size suffix, so SQLite columns declared `INTEGER`, `REAL` or `DECIMAL(10,2)` get a numeric type instead of `string`: an `INTEGER` column is `{ type: 'integer' }` in the generated schema, where it was `{ type: 'string' }`, which a client generated from the OpenAPI document sees. `columnToSchema()` is exported with its result type `IColumnJsonSchema`, and `normalizeSqlType()` with it.

---
"@spinajs/orm-history": patch
---

History compares a column the model declares as JSON (`@Json()`, or `@Column` with `family: 'json'` or a `json` / `jsonb` `nativeType`) by its parsed value where the driver hands it over as text (sqlite, MSSQL): the same JSON written with its keys in another order or other whitespace no longer records an update, as on Postgres and MySQL. Text that does not parse, and JSON text in a column not declared as JSON, is compared as text. `before` and `after` keep the values the driver returned.

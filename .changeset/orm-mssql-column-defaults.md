---
"@spinajs/orm-mssql": patch
---

`tableInfo()` reads a column's default as a value instead of SQL Server's stored text. A new model took `'((0))'`, `'(N''a'')'` or `'(newid())'` as a column's value, so its insert failed (a conversion error) or wrote that text. Now a literal default becomes the value tedious reads from a column of that type (`((0))` on an `int` is `0`, on a `bit` `false`, on a `bigint` `'0'`; `(N'it''s')` is `it's`; `(NULL)` is `null`), and an expression (`(getdate())`, `(newid())`, `NEXT VALUE FOR`) or a literal of another type is a `RawQuery`, which a new model leaves unset so the insert sends `DEFAULT`. Schema diff and migration codegen now see these values where they saw the text, as on the other dialects.

---
"@spinajs/orm-mssql": patch
---

An upsert (`insert().onDuplicate()`) of more than one row is refused with `NotSupported` before the `MERGE` is sent (a split upsert still sends `BEGIN` and `ROLLBACK`, and write capture reads first). `NotSupported` is not an `OrmException`. Before, SQL Server refused the statement as a syntax error (102), and an upsert split into statements of one row by `MaxBindings` / `MaxInsertRows` matched every statement on the first row's key, so the other rows were never written. Upsert one row per call, inside one `transaction()` when the rows belong together.

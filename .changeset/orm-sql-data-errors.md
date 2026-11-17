---
"@spinajs/orm": minor
"@spinajs/orm-postgres": patch
"@spinajs/orm-mysql": patch
"@spinajs/orm-mssql": patch
---

New `DataException` (extends `OrmException`): the postgres, PGlite, mysql and mssql drivers throw it when the database refuses a value (SQLSTATE class 22, MySQL's `ER_WRONG_VALUE`, or SQL Server's conversion, overflow and truncation errors). Its message names the code, not the native message, which quotes the refused value; the native error stays its `inner`. The sqlite driver never throws it. When a page asked with `after` or `before` fails with it, `paginate()` asks the database about the cursor's predicate alone and reports `InvalidCursor` when that is refused too, so a crafted cursor that passes the type check but not the column (a label a postgres enum lacks) answers 400 instead of 500. Inside a transaction on PostgreSQL, PGlite and SQL Server the page error has already aborted the transaction, so the probe cannot run and the error stays a `DataException`. A data error from the query's own conditions or from a populated relation stays a `DataException`.

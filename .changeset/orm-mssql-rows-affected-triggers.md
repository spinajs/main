---
"@spinajs/orm-mssql": patch
---

Inserts, updates and deletes report their own `RowsAffected` on tables with triggers. The `mssql` driver lists the counts of an `AFTER` trigger's statements before the statement's own, so an insert of one row into a table whose trigger wrote two rows elsewhere reported `RowsAffected: 2`. An insert batch now selects its own `@@ROWCOUNT` as `INSERTED` (`; SELECT SCOPE_IDENTITY() as ID, @@ROWCOUNT as INSERTED;`), read from the batch's last result set, and an update or a delete reads the last count the driver reports.

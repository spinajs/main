---
"@spinajs/orm": minor
---

`supportsRowLocks(driver)` is exported: it tells whether a select on the connection may call `forUpdate()` and `forShare()` (MSSQL has no row lock clause and both throw `NotSupported`). The write capture's locked reads use it. The JSDoc of `forShare()` no longer claims it sees rows committed after the snapshot everywhere: that holds on MySQL, not on PostgreSQL REPEATABLE READ or SERIALIZABLE.

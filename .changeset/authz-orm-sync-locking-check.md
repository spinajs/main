---
"@spinajs/authz-orm": patch
---

The check after a narrowed `sync()` orphan statement is a locking read of one key (`FOR SHARE`, `LOCK IN SHARE MODE` on MySQL) instead of a count. Under MySQL REPEATABLE READ the count read the transaction's snapshot, so a `sync()` inside a transaction that had already read resolved with a denied row another transaction committed after that read; it is now refused with `AccessDenied` and rolled back. The rows left are counted only on the refusal path, for the log line. MSSQL, which has no row lock clause, keeps a plain read.

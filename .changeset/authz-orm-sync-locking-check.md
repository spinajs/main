---
"@spinajs/authz-orm": patch
---

The check after a narrowed `sync()` orphan statement is a locking read of one key (`FOR SHARE`, `LOCK IN SHARE MODE` on MySQL) instead of a count. Under MySQL REPEATABLE READ the count read the transaction's snapshot. A many-to-many `sync()` fixes that snapshot itself, with its plain select of the existing junction rows. A `sync()` inside a transaction that had already read starts from that earlier snapshot. Either way, the `sync()` resolved with a denied row that another transaction committed after the snapshot. Now it is refused with `AccessDenied` and rolled back. The rows left are counted only on the refusal path, for the log line. MSSQL, which has no row lock clause (`supportsRowLocks()`), keeps a plain read. PostgreSQL under REPEATABLE READ or SERIALIZABLE stays exposed, as its locking reads see only the snapshot.

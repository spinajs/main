---
"@spinajs/orm": patch
---

A model select whose replica the driver gave up on (its reconnect attempts ran out, on PostgreSQL and MySQL) runs once more on another healthy replica or the primary, instead of failing. SQL errors are not run again, also on a degraded replica, and a stream stays on the connection it picked. `Resilience: { MaxRetries: 0 }` on a replica entry makes the move immediate. SQL Server and SQLite replicas are unchanged: their drivers do not mark a lost replica.

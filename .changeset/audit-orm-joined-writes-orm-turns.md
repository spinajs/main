---
"@spinajs/audit-orm": patch
---

A joined confirmed write (sqlite, PGlite, inside the caller's transaction) no longer waits behind the joined writes before it in a chain of its own: its savepoint takes its turn in the ORM's queue of that transaction, which orders the savepoints of one transaction now. With the ORM's queue that chain hung for good: a `record` (or an audited read) beside a nested `driver.transaction()` that also records never settled, and on SQLite every other transaction of the process waited with it. Parallel joined writes of one transaction still run one after another, in the order they reach the driver, and keep their rows when another one fails.

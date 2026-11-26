---
"@spinajs/orm-pglite": patch
---

`PglitePoolClient.release(err)` and `release(true)` roll the one PGlite session back before the next lease, where pg-pool would destroy a socket client. The postgres driver releases a client this way when a transaction fails to open and when its `ROLLBACK` fails; before, the session stayed in the aborted transaction and every later statement failed with `current transaction is aborted` (25P02) until the process restarted. If the adapter's own `ROLLBACK` fails, the pool is ended instead of handing the session out: waiting and later leases are rejected.

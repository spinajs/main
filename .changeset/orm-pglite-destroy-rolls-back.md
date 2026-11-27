---
"@spinajs/orm-pglite": patch
---

`PglitePoolClient.release(err)` and `release(true)` roll the one PGlite session back before the next lease, where pg-pool would destroy a socket client. The postgres driver releases a client this way when a transaction fails to open and when its `ROLLBACK` fails; before, the session stayed in the aborted transaction and every later statement failed with `current transaction is aborted` (25P02) until the driver reconnected, which for an in-memory database means an empty one. If the adapter's own `ROLLBACK` fails (only when the PGlite instance itself is broken), the pool is ended instead of handing the session out: statements fail with an `OrmException` wrapping "failed to roll back" until the next health check (`Resilience.HealthCheckInterval`, 30 s by default) or `driver.connect()` opens a new instance, which for an in-memory database starts empty; a `Shared` instance is replaced only after every connection on it has let go.

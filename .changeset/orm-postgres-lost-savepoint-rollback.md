---
"@spinajs/orm-postgres": patch
---

A nested `transaction()` whose `ROLLBACK TO SAVEPOINT` fails (a client-side `query_timeout` that leaves it unsent) makes the outermost transaction refuse to commit: `transaction()` rejects with `OrmException`, `ROLLBACK` is sent and the client is destroyed. Before, an outer callback that caught the nested rejection and went on committed the work the nested call had reported as undone. The same refusal now follows every failed `ROLLBACK TO SAVEPOINT`, also one the server refused (`3B001`, where `transaction()` used to resolve with nothing written), one whose connection broke, and one the server ran but whose answer was lost (then, and when an enclosing nested call later rolls back to its own savepoint, the work would have been correct, but the driver cannot tell, so retry the whole `transaction()`).

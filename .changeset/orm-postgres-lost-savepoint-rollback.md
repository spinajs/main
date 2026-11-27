---
"@spinajs/orm-postgres": patch
---

A nested `transaction()` whose `ROLLBACK TO SAVEPOINT` fails (a client-side `query_timeout` that leaves it unsent) makes the outermost transaction refuse to commit: `transaction()` rejects with `OrmException`, `ROLLBACK` is sent and the client is destroyed. Before, an outer callback that caught the nested rejection and went on committed the work the nested call had reported as undone.

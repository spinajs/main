---
"@spinajs/orm-postgres": patch
---

`@spinajs/orm-postgres` (and `@spinajs/orm-pglite`, which inherits it): a transaction whose callback caught the error of a failed statement and then returned now rejects with `OrmException` ("… was aborted by an earlier failed statement …"), and its `afterCommit()` callbacks do not run. PostgreSQL had already aborted such a transaction and answered the driver's `COMMIT` with `ROLLBACK`; before, `transaction()` resolved and ran those callbacks although nothing of the transaction was written. An application that caught such an error (a constraint violation, a missing table, a caught `statement_timeout`) and relied on the rest being committed lost that work silently and now gets this rejection, also when the failed statement was only a read. Do not swallow a statement's error inside a transaction; to recover from a statement that may fail and commit the rest, run it in a nested `transaction()` (a savepoint).

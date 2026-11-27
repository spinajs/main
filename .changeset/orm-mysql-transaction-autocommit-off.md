---
"@spinajs/orm-mysql": patch
---

**Behaviour change.** Statements after an implicit commit inside a transaction are now part of the transaction, and a rollback discards them; each of them used to commit on its own. Statements with an implicit commit are DDL, `TRUNCATE`, `LOCK TABLES`, a raw `COMMIT` or `ROLLBACK`, and a procedure that commits.
- Under `Migration.Transaction.Mode = PerRun`, a failing migration therefore also rolls back the "finished" rows of the migrations since the last DDL. Use `PerMigration` on MySQL. The default mode, `None`, is not affected.
- A `SET autocommit = 1` issued inside the callback now commits the transaction so far.
- A raw `SET autocommit = 0` inside the callback no longer leaves the pooled connection at autocommit 0.

A MySQL transaction now runs with `autocommit = 0` on its connection, from begin to release. After a deadlock, InnoDB rolls the whole transaction back. A statement the callback had issued in parallel (not awaited), and that was already queued on the connection, used to commit on its own while `transaction()` rejected, so one write stayed. That statement now lands in a new implicit transaction, and the driver's final `ROLLBACK` discards it. The exception is a statement with an implicit commit among the queued ones: it commits the statements queued before it.

The connection goes back to the pool only after `COMMIT` or `ROLLBACK` succeeded and `SET autocommit = 1` answered. Otherwise it is destroyed: a pooled connection left at autocommit 0 would never commit a write of its next user. Before this change, a connection whose `ROLLBACK` failed went back to the pool with its transaction still open.

Each transaction costs two more round trips: five statements where there were three.

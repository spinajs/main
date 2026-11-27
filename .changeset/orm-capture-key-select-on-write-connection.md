---
'@spinajs/orm': patch
---

The write capture's key select runs on the connection that runs the write, in the write's database, and its before and after reads use the write's database too. Without this fix, with the confinement of a captured write to the keys its key select read, a save inside a shared-server unit of work that updates or deletes a row the same transaction inserted is silently lost: the key select ran on the model's own connection, outside the transaction, found no row, and the write matched nothing. On MySQL that key select instead waited on the transaction's own row lock until the lock wait timeout, retried as a transport error (about five minutes with the default settings) and failed the save. A model update or delete that names another database with `.database(x)` is now keyed, read and confined in `x`, not in the connection's `Database`.

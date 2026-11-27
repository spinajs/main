---
"@spinajs/orm-postgres": patch
---

A transaction one of whose statements got no answer from the server (pg's client-side `query_timeout`) no longer commits when its callback caught that error and went on: `transaction()` rejects with `OrmException` (the timeout as `inner`), `ROLLBACK` is sent and the client is destroyed. Before, the statement kept running on the server and the `COMMIT` queued behind it committed it, although the caller had been told it failed. Any other statement failure that is not the server's answer (a connection error, a `FATAL` answer that ended the session, a parameter the client cannot serialize) refuses the commit too. An application that catches such a timeout inside a transaction and wants the rest committed now gets the rejection: retry the whole transaction, and keep a server-side `statement_timeout` at or below `query_timeout`.

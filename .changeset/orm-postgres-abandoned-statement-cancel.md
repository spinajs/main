---
"@spinajs/orm-postgres": patch
---

A statement outside a transaction that got no answer from the server (pg's client-side `query_timeout`) is now cancelled on the server when its client is destroyed: the driver sends PostgreSQL's cancel request with the backend's process id and secret key, so the backend stops running it and a write it was making rolls back. Repeated timeouts no longer leave one busy server connection per abandoned statement beside the pool. A stream whose read fails without a server answer is cancelled the same way. The cancel is fire and forget: a failure is logged at `debug` and the caller still gets the timeout. `Options.CancelAbandonedStatements: false` turns it off. Not covered: statements inside a transaction, a pooler that does not forward cancel requests, and a statement that finished before the cancel arrived. A server-side `statement_timeout` below `query_timeout` stays the recommended first line.

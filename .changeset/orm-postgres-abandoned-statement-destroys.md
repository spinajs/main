---
"@spinajs/orm-postgres": patch
---

Outside a transaction, a pooled client whose statement got no answer from the server (pg's client-side `query_timeout`) is destroyed instead of returned to the pool. Before, the next statement on that client waited until the abandoned statement ended on the server, or timed out without running. The abandoned statement still runs, and its writes still commit, until it ends: while it runs the server holds one connection more than the pool counts. Set a server-side `statement_timeout` at or below `query_timeout`.

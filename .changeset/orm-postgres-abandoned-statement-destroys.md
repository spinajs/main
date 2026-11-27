---
"@spinajs/orm-postgres": patch
---

Outside a transaction, a pooled client whose statement got no answer from the server (pg's client-side `query_timeout`) is destroyed instead of returned to the pool. Before, the next statement on that client waited until the abandoned statement ended on the server, or timed out without running. The statement it abandoned is cancelled on the server (see the entry on cancelling abandoned statements); where the cancel cannot reach the server, it runs to its end beside the pool's replacement. Keep a server-side `statement_timeout` below `query_timeout`.

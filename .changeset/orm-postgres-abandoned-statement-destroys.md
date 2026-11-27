---
"@spinajs/orm-postgres": patch
---

Outside a transaction, a pooled client whose statement got no answer from the server (pg's client-side `query_timeout`) is destroyed instead of returned to the pool. Before, the next statement on that client waited until the abandoned statement ended on the server, or timed out without running. The abandoned statement still runs, and its writes still commit, until it ends: each such statement keeps its backend busy beside the pool's replacement, so repeated timeouts take the server past `Pool.Max`, up to its `max_connections`. Set a server-side `statement_timeout` below `query_timeout`. On PostgreSQL 14 and later, `client_connection_check_interval` also ends such a statement soon after its client is destroyed.

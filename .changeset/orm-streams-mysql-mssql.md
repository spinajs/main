---
"@spinajs/orm-mysql": minor
"@spinajs/orm-mssql": minor
---

`query.stream()` reads rows as they arrive on mysql (mysql2 row events, the connection paused while a batch waits) and mssql (tedious stream mode, the request paused while a batch waits), buffered in `RowQueue`. Leaving the loop early releases the connection: mysql destroys the pooled connection and closes its socket so the server stops sending, mssql cancels the request. A result read to its end returns the connection to the pool.

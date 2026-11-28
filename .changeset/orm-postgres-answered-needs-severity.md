---
"@spinajs/orm-postgres": patch
---

A transaction statement whose error carries no server `severity` now refuses the commit: pg-protocol's own "received invalid response" (a protocol desync) is a `DatabaseError` without one, and was read as a server answer, so a `COMMIT` could follow a statement the server may still run.

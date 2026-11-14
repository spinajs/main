---
"@spinajs/orm-sql": minor
"@spinajs/orm-postgres": minor
---

`query.stream()` reads from a server-side cursor on postgres (`pg-cursor`, new dependency, parsed with the pool's UTC type parsers). Leaving the loop early closes the cursor and returns the client to the pool; a client whose connection was lost is dropped. `RowQueue` in `@spinajs/orm-sql` is a pause/resume buffer for drivers whose client pushes rows as events. PGlite has no pg client to put a cursor on and streams by keyset. Inside an open transaction every driver streams by keyset, so a statement in the loop body never waits behind a cursor on the transaction's connection.

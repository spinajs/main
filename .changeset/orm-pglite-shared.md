---
"@spinajs/orm-pglite": minor
---

`Options.Shared` puts connections on one process-wide PGlite instance, each in its own `Options.Schema`. Leases of the single session are handed out in order and switch `search_path` to the holder's schema, so transactions of different connections never interleave. `acquireSharedPglite()` and `execOnSharedPglite()` expose the instance; an unused one closes after a second.

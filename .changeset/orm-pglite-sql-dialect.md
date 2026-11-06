---
"@spinajs/orm-pglite": minor
---

`@spinajs/orm-pglite` declares its own SQL dialect profile, `pglite` (`PGLITE_SQL_DIALECT`), so a PGlite app is no longer reported as SQL011 at build time. Its values match the `postgresql` profile.

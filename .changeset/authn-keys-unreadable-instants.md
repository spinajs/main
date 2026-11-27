---
"@spinajs/authn-keys": patch
---

`OrmKeyStore`: a key whose `expires_at` or `revoked_at` holds a value no datetime converter reads (text written by hand on SQLite, a MySQL zero date, a PostgreSQL `infinity` or `-infinity`) is no longer usable: it counts as expired and revoked. Before, it read as never expiring and not revoked, so a revocation written that way did not hold. A warning names the kid on each read of such a row. `authn:key-list` prints such an instant as `unreadable`, and `authn:key-revoke` leaves such a value as it is (the store answers `already`, so no `key.revoke` event is written). Only SQL `NULL` means "never expires": a key written by hand with PostgreSQL `infinity` for "never expires" stops working and must be set to `NULL`. The docs give a query per database that finds such keys.

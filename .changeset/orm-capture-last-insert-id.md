---
"@spinajs/orm": patch
---

The write capture takes a driver's `LastInsertId` as the key of an inserted row only when the model's primary key is an auto-increment integer. A single-row insert without `RETURNING` that leaves any other key to the database (a text or `BLOB` key with a default, a UUID default) now reaches observers with `unknownKeys: true` and no rows, instead of being looked up by the rowid, which found no row or another row whose key equals it.

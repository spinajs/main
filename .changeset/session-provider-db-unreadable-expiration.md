---
"@spinajs/session-provider-db": patch
---

A `user_sessions` row whose `Expiration` holds a value no datetime converter reads (text written by hand on SQLite, a MySQL zero date, a PostgreSQL `infinity` or `-infinity`) is now an expired session: `restore` answers `null`, `listBySubject` leaves it out, and `deleteBySubject` and `deleteByExternalKey` delete it without counting it. Before, the converter read such a value as null and the session never expired. Only SQL `NULL` means a never-expiring session: a PostgreSQL `infinity` written to mean "never" now ends that session, so write `NULL` instead. The store logs a warning naming the subject on each read of such a row. Rows the store wrote always hold a readable value or `NULL`.

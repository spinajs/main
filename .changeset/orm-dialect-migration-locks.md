---
"@spinajs/orm": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-mssql": minor
"@spinajs/orm-pglite": patch
---

postgres, mysql and mssql take the migration lock as a session lock of the database (`pg_advisory_lock`, `GET_LOCK`, `sp_getapplock`) on a connection held for the whole run, with the lock-table row as well, so processes of an older release still exclude this one (`SessionMigrationLock`). Behind PgBouncer in transaction pooling, or on a mysql multi-primary cluster, set `Migration.Lock.Mode: 'table'` before upgrading. `@spinajs/orm-pglite` keeps the lock-table row: an in-process PGlite has one session, so no session lock can be held beside the pool.

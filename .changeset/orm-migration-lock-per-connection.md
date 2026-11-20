---
"@spinajs/orm": minor
---

A migration run holds one lock per connection from before it reads the tracking table until after the `data()` seeds, so a second run waits for the seeds too. The lock is a `MigrationLock` service of the driver: `TableMigrationLock` (the `spinajs_migration_lock` row, refreshed while held) unless the driver registers its own; `Migration.Lock.Mode: 'table'` forces the row. Two connections on one database that share `Migration.Table` now block each other: give each its own table. The protected `acquireLock()`, `releaseLock()` and `lockOwner()` of `DefaultMigrationService` moved to `TableMigrationLock`.

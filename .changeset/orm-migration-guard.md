---
"@spinajs/orm": minor
---

`OrmMigrationGuard` checks the tracking tables of every connection read-only and reports the pending and failed migrations (`PendingMigrationsException`, `pendingMigrationsMessage()`); `db.MigrationCheck` (`'fail' | 'warn' | 'off'`) and `db.Connections[].Migration.Check` set what it does with them.

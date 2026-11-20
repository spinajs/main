---
"@spinajs/orm": minor
"@spinajs/orm-cli": minor
---

Migration status is read-only: `MigrationRunner.status({ readOnly, connection })` and `OrmMigrationService.status(units, { readOnly })` create and upgrade no tracking table, and on a database without one every migration reads pending. `migrate-status` shows when each migration was applied and the order the pending ones would run in, and takes `--connection` and `--json`.

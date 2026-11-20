---
"@spinajs/orm": minor
"@spinajs/orm-cli": minor
---

`migrate-seed [--name] [--connection]` reruns the `data()` seeds of the applied migrations under the run lock (`OrmMigrator.seed()`); `migrate-up --skip-seed` applies without them and `migrate-up --dry-run` prints what it would apply (`OrmMigrator.plan()`). `migrateTestDatabase(container)` from the new `@spinajs/orm/testing` entry migrates and seeds a test database through the migration tool and refuses to run with `NODE_ENV` or `APP_ENV` production.

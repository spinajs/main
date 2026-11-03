---
"@spinajs/orm": major
"@spinajs/orm-cli": patch
"@spinajs/configuration-db-source": patch
"@spinajs/electron": patch
---

`Orm.resolve()` applies the pending `Migration.OnStartup` migrations before it reads table info, and their `data()` seeds run once the `Orm` is cached; `orm.Migrator.ready()` settles after them. Resolve the `Orm`, not `OrmMigrator`: `DI.resolve(OrmMigrator)` migrates nothing. A migration tool calls `resolveMigrationTool()`. A failed migration rejects `DI.resolve(Orm)` and caches no `Orm`. `AwaitsStartupMigration` is removed. Brought from 3.0.24 (#412).

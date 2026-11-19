---
"@spinajs/orm": major
"@spinajs/orm-cli": major
"@spinajs/orm-sqlite": patch
"@spinajs/authn-keys": major
"@spinajs/authn-local": major
"@spinajs/authn-orm": major
"@spinajs/authn-token": major
"@spinajs/authn-totp": major
"@spinajs/authz-orm": major
"@spinajs/authz-rbac": major
"@spinajs/scheduler": major
"@spinajs/upload": major
"@spinajs/users": major
"@spinajs/configuration-db-source": patch
"@spinajs/electron": patch
---

The application never migrates. `Orm.resolve()` applies no migration and runs no `data()` seed: it reads the tracking tables through `OrmMigrationGuard` and fails with `PendingMigrationsException` while a migration is pending or failed, naming the migrations and `npx spinajs migrate-up`; it closes the connections it opened and caches no `Orm`.

What stops working:

- `Migration.OnStartup` is removed from `IDriverOptions`, and a configuration that still sets it, `true` or `false`, fails the boot.
- `Orm.Migrator`, `orm.Migrator.ready()`, `IOrmMigratorOptions`, `OrmMigrator.MigrateOnStartup`, `boot()` and `ready()`, and `IMigrationUpOptions.force` are removed. `DI.resolve(OrmMigrator)` throws an `OrmException` naming `resolveMigrationTool()`.
- The CLI commands of `authn-keys`, `authn-local`, `authn-orm`, `authn-token`, `authn-totp`, `authz-orm`, `authz-rbac`, `scheduler`, `upload` and `users` boot the `Orm` as an application does and refuse an unmigrated database.

What to do instead:

- Run `npx spinajs migrate-up` as a deploy step, before the application starts, and remove `Migration.OnStartup` from `db.Connections`. Several instances may run it at once: the run holds a lock per connection. Rerun seeds with `npx spinajs migrate-seed`.
- A process that has to migrate itself (a desktop or Electron main process) calls `await (await resolveMigrationTool()).migrate()` before anything resolves the `Orm`.
- Tests call `await migrateTestDatabase(container)` from `@spinajs/orm/testing` before anything resolves the `Orm`; a harness that creates its tables by hand sets `db.MigrationCheck: 'off'`. Harnesses that uncache `Orm` and `OrmMigrator` uncache `OrmMigrationGuard` too.
- For local development `db.MigrationCheck: 'warn'` boots over pending migrations with a warning.
- A database whose schema exists without tracking rows fails the boot with everything pending: check the schema, then run `npx spinajs migrate-up --fake` once.

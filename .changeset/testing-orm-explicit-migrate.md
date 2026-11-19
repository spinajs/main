---
"@spinajs/testing-orm": major
---

`createTestDatabase()` no longer hands out a connection the app's boot migrates, because the boot never migrates now. `TestDatabase.config` carries no `Migration` key (with `migrate: false` it carries `Migration: { Check: 'off' }`, so the boot does not check the migrations it deliberately leaves unrun). Call the new `TestDatabase.migrate(container)` after creating the app and before anything there resolves the `Orm`: it applies the pending migrations and their `data()` seeds through the migration tool of that container and resolves with its `Orm`. An app that resolves the `Orm` first fails with `PendingMigrationsException`. The `template` strategy builds its dump with the migration tool, and `migrate()` applies the migrations registered after the template was taken.

```ts
// before
const app = await createTestApp({ config: { db: { Connections: [db.config] } }, resolve: [OrmMigrator] });

// now
const app = await createTestApp({ config: { db: { Connections: [db.config] } } });
const orm = await db.migrate(app.container);
```

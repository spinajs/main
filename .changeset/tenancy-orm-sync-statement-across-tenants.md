---
'@spinajs/tenancy-orm': minor
---

`.acrossTenants(reason)` is declared on `IRelationSyncStatement` of `@spinajs/orm`, the `this` of a relation list's `sync()` callback, so `this.acrossTenants(reason)` type-checks there and widens the statement that removes the orphans to every tenant. Without it that statement stays in the current tenant.

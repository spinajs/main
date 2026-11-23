---
'@spinajs/authz-orm': minor
---

The runtime guard covers a relation list's `sync()`: the update or delete it removes orphans with, on an `@AccessResource` model, needs `.accessible(permission)` or `.unscoped(reason)` in the `sync()` callback, `SYSTEM` or a route marked `@Unscoped(reason)`, and the many-to-many select of existing links is no longer flagged. Inside a `sync()` callback `.accessible()` refuses instead of narrowing: a `none` plan is `AccessDenied` before the statement, and when a filtered statement leaves rows of its own conditions behind (one count after it, in its transaction) the call is refused and rolled back, with `AccessDenied` when the plan filtered and `AuthzConfigError` when only `.within()` did. `.accessible()`, `.unscoped()` and `.within()` are declared on `IRelationSyncStatement` of `@spinajs/orm`, the `this` of that callback.

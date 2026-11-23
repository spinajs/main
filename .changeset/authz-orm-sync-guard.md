---
'@spinajs/authz-orm': minor
---

The runtime guard covers a relation list's `sync()`: the update or delete it removes orphans with, on an `@AccessResource` model, needs `.accessible(permission)` or `.unscoped(reason)` in the `sync()` callback, `SYSTEM` or a route marked `@Unscoped(reason)`, and the many-to-many select of existing links is no longer flagged. Inside a `sync()` callback `.accessible()` refuses instead of narrowing: a `none` plan, or a plan that would reach fewer rows than the statement, is `AccessDenied` and rolls the call back.

---
"@spinajs/authz-orm": minor
---

`.accessible()`, `.unscoped()` and `.within()` are installed by `AuthzSelectExtension`, `AuthzUpdateExtension` and `AuthzDeleteExtension`, and `.withAccess()` by `AuthzAccessFieldsExtension`, query extensions, when the Orm resolves, instead of being assigned to the builder prototypes at import. Behaviour change: the methods exist only after `Orm.resolve()`. A clone keeps the access marks through `onClone` instead of a wrapped `SelectQueryBuilder.prototype.clone`. New exports (from `@spinajs/authz-orm`, not from its frozen `api`): the four extension classes.

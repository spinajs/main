---
"@spinajs/authz-orm": patch
---

The refusal of `.accessible()`, `.within()`, `.withAccess()` and `.withFields()` on a query that never runs on its own now asks the ORM how the query is executed (`state().execution`) instead of looking at the relation's type and at the builder's owner. No behaviour change: the same calls throw the same `AuthzConfigError`. A custom relation that declares its query as merged is refused too.

---
"@spinajs/authz-orm": patch
---

A query that still carries `.accessible()`, `.within()`, `.withAccess()` or `.withFields()` when the ORM folds it into another query now throws `AuthzConfigError` at that moment. The four methods already refuse such a query when they are called; this covers a mark that got there another way, so it can no longer be dropped silently.

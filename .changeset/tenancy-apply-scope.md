---
"@spinajs/tenancy": minor
---

`@spinajs/tenancy`: `applyTenantScope(store, scope)` changes the tenant scope of a request store in place, for entry-point glue that owns the store (an HTTP or socket middleware). Like a change of the ambient scope, it asks the scope-change guards first and drops the authz request cache of the outer scope; a scope equal to the store's is no change.

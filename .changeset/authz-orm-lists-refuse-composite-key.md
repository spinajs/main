---
"@spinajs/authz-orm": patch
---

`.accessible()`, `.within()`, `.withAccess()`, `.withFields()` and `.unscoped()` now throw `AuthzConfigError` on an `@AccessResource` model with a composite primary key, and so does the list middleware when such a query runs. The authz domain boot already refused such a model, but a class registered after the boot (a module imported later, or a late `registerAccessResource()` call) was listed keyed by its first key column alone: with `Line` keyed `(order_id, id)` and a grant on `line:o1`, `.accessible('line:read')` returned every line of order `o1`, other users' lines included. The error is the boot's composite-key message. A model with a single-column key is not affected.

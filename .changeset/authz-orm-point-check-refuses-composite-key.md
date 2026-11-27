---
"@spinajs/authz-orm": patch
---

A single-object check now throws `AuthzConfigError` on an `@AccessResource` model with a composite primary key: `OrmResourceAdapter.refOf()`, the row load behind `ancestors()` / `load()`, and the `owner`, `self` and `@Relation` resolvers. The authz domain boot already refused such a model, but a class registered after the boot under a type the domain knew was keyed by its first key column alone: with `Line` keyed `(order_id, id)` under type `doc` and a grant on `doc:o1`, `check(alice, 'doc:update', bobsLine)` was allowed, and a check of the ref `doc:o1` loaded the first line it found. The error is the boot's composite-key message, and every check of a ref of that type throws it until the class is removed. A model with a single-column key is not affected.

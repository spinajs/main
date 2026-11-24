---
"@spinajs/orm": patch
---

A many-to-many list's `update()` and `sync()` no longer write a missing link as an upsert of a junction model instance (`InsertBehaviour.InsertOrUpdate`). The link is a plain insert on the junction model, built like the junction rows of `save()`: the columns of the junction model the list holds for the member, then the two key columns. A tenant junction model of `@spinajs/tenancy-orm` now gets its tenant column on these links. A pair that another transaction links between the read of existing links and the insert fails on a unique index of the junction table instead of being updated. A member added without junction data still gets the columns a new junction model is constructed with. `update()` and `sync()` no longer need a `@BelongsTo` to both sides on the junction model; `populate()` still does. An unsaved member is still inserted with `InsertBehaviour.InsertOrUpdate`.

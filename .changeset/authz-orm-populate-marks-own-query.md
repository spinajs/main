---
"@spinajs/authz-orm": patch
---

`.accessible()`, `.within()`, `.withAccess()` and `.withFields()` called in the populate callback of a belongsTo or many-to-many relation now throw `AuthzConfigError` naming the relation. Those relations never run the callback's query: a belongsTo query is merged into the parent query and a many-to-many relation runs its junction query, so the call used to be dropped without a word and the related rows came back unfiltered. Code that made such a call now throws: filter the parent query, populate through a hasMany relation, or load the related rows with their own `.accessible()` query. A hasMany relation runs its own query and keeps working as before.

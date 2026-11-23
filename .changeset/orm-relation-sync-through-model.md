---
"@spinajs/orm": minor
---

Relation `sync()` deletes pass the model's query middleware and the write capture: `sync()` and `update()` of a one-to-many or many-to-many list build every statement on the target or junction model, so a tracked model records the orphan delete in its history and a tenant model's statements are confined to the tenant scope. The rows written and deleted are the same as before.

---
"@spinajs/orm-history": minor
---

`forget` also erases on the trail's own connection: `Model.history().forget(id)`, `row.history().forget()` and `historyOf(...).forget(...)` erase the subject `{ type: <entity>, id }` on the trail's configured `connection` first and then on the model's connection, once when they are the same connection, and return the events redacted on both. A trail whose own connection has no trail table rejects the call before anything is erased. A model on a third connection that records under the same entity is not touched; one on the trail's own connection that records under the same entity is erased with it, so give such models distinct `entity` names. `audit().trail(name).forget(subject)` without a `source` remains the sweep over every connection. Reads still cover the model's connection only.

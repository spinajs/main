---
"@spinajs/orm-history": minor
---

`forget` also erases on the trail's own connection: `Model.history().forget(id)`, `row.history().forget()` and `historyOf(...).forget(...)` erase the subject `{ type: <entity>, id }` on the model's connection and on the trail's configured `connection`, once when they are the same connection, and return the events redacted on both. A model on another connection that records under the same entity is not touched; `audit().trail(name).forget(subject)` without a `source` remains the sweep over every connection. Reads still cover the model's connection only.

---
"@spinajs/orm-history": minor
---

`forget` covers every source of the trail: `Model.history().forget(id)`, `row.history().forget()` and `historyOf(...).forget(...)` erase the subject `{ type: <entity>, id }` as `audit().trail(name).forget(subject)` without a `source` does, so the events of the subject on the trail's own connection are redacted too, and the result counts the events redacted over every source. Reads still cover the model's connection only.

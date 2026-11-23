---
"@spinajs/orm-history": minor
---

`HistoryQuery.changed` keeps the entries that changed one of the named columns, on `Model.history().of`, `.since`, `.byActor` and `row.history().entries`. `Model.history().byActor(actor, query?)` lists the row changes one principal made to a model.

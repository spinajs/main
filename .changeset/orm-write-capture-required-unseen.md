---
"@spinajs/orm": minor
---

`db.WriteCapture.Required` also refuses a write of a listed table that goes past its model, with `WriteCaptureRequired`, before its statement is sent: an insert (upsert included), update, delete or truncate builder without a model (the helpers `insertChunked`, `deleteChunked`, `purgeBatch` and `bumpVersionRow` included), `Model.truncate()`, and a model builder pointed at a listed table that is not its own. Names are compared by their table part (`public.invoice`, `"dbo"."invoice"` and `invoice` name one table) without case, in the list and in the write; a write past the model whose name has no readable table part, or that names no table, is refused while any table is listed. Raw SQL and schema builders still pass. The boot warning about a listed name no model has now says that only that table's writes past a model are refused in the process. Nothing changes while the list is empty.

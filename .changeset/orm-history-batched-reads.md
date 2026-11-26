---
"@spinajs/orm-history": minor
---

`ModelHistory` reads many rows at once: `latestBefore(ids, at)` and `latest(ids)` return the last entry of each id at or before an instant or at all, and `current(ids)` and `currentWhere(where, limit)` return the current rows, each encoded as the `after` of an entry written for it reads back from the trail, so the two compare with a deep equality. On a table trail all four read on the primary. The two `current` reads select the table without the model: soft-deleted rows are returned, no authz filter and no read audit apply, and a tenant model needs a tenant scope. Code that implements `ModelHistory` itself must add the four members.

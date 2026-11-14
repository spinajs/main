---
"@spinajs/authz-rebac": patch
---

`DbTupleStore.writeIn` no longer runs `SELECT ... WHERE tuple_key = ?` once per removed and once per added tuple: it reads the stored keys of each side once, with `whereIn(tuple_key)` in chunks of 500. A tuple removed and re-added in one call is still inserted, and duplicates in one call count once, as before.

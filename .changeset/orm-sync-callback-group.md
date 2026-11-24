---
"@spinajs/orm": patch
---

The conditions a relation list's `sync(callback)` adds become one group, ANDed with the owner key and the kept members. A callback with `orWhere()` used to be appended without brackets, so the orphan delete (or soft-delete stamp) reached rows of other owners; now it narrows what `sync()` removes and never reaches past the owner. The owner key and the kept members also hold when the callback removes, reorders or reconnects the statement's where statements. A callback that adds no condition leaves the statement as it was.

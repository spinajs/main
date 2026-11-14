---
"@spinajs/di": patch
---

A `@PerInstanceCheck()` element resolved on its own before its `Array.ofType(T)` list now appears in that list, in its registration slot. Before, the list was built without it, so consumers iterating the list never saw it.

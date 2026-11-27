---
"@spinajs/compiler": patch
---

A reply type is unwrapped to its payload when it extends the `Response` of `@spinajs/http`, not because it is named `Ok`, `Json`, `Created` and so on. An application class of such a name that is no http response keeps its own schema. `BadRequest` and `Forbidden`, which are exceptions and never were reply classes, left the list.

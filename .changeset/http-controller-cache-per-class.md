---
"@spinajs/http": patch
---

The TypeScript controller cache keeps an entry per controller class. Without a manifest, the controllers declared in one file shared one entry, written by whichever was read first. The others got that controller's class description, tags and method documentation in the OpenAPI document. For route argument binding they got its parameter names for an action of the same name; an action only they declare was not affected, its names are read from the function. Existing cache entries are regenerated once.

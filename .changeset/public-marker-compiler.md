---
"@spinajs/compiler": minor
---

The controllers extractor records `@Public` of `@spinajs/http` as `public`, found by resolving the decorator, not by name. Doctor rule HTTP002 treats it like `@AllowAnonymous`; the new HTTP006 warns when it sits next to `@Access` or `@Policy`.

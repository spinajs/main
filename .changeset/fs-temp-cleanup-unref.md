---
"@spinajs/fs": patch
---

The cleanup schedule of a temp filesystem with `cleanupCronExpression` no longer keeps the process alive; `dispose()` still stops it.

---
"@spinajs/testing": patch
---

`disposeTestApps()` disposes every live app even when one `dispose()` fails, then rethrows the first error (eg. the `RestoreIncomplete` a root app's restore rejects with).

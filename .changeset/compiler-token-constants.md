---
"@spinajs/compiler": minor
---

The analyzer reads `token<T>(key)` constants (imported, re-exported or declared in a workspace package's declaration file) and records their key in `registeredAs`, `ValueEntry.token`, injections and `DI.resolve` calls, so a token registration and a string registration of one key look the same to the manifest and to doctor DI001. `asToken(T)` counts as a registration. CMP005 (info) reports a token whose key cannot be read.

---
"@spinajs/compiler": minor
---

The analyzer reads `token<T>(key)` constants (imported, re-exported or declared in a workspace package's declaration file) and records their key in `registeredAs`, `ValueEntry.token`, injections and `DI.resolve` calls, so a token registration and a string registration of one key look the same to the manifest and to doctor DI001. `asToken(T)` counts as a registration. A key that cannot be read (no declaration map, malformed map, missing source, non-literal key) is recorded as the reserved `token:unresolved:<module>#<export>`, which doctor DI001/DI002/DI003 skip, with a CMP005 warning naming the failed step; it never becomes the constant name.

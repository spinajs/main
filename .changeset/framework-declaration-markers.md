---
'@spinajs/orm': patch
'@spinajs/authz-orm': patch
'@spinajs/authz': patch
'@spinajs/principal': patch
---

Builders, `clone()`, `accessible()` / `unscoped()`, `runAs()` and `SYSTEM` carry `@spinajs` declaration markers that the compiler reads; no runtime change.

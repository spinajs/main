---
"@spinajs/compiler": patch
---

A hand-written `@Middleware(TenantMiddleware, ...)` is recognised by symbol, so one that imports `TenantMiddleware` under an alias also leaves its route undeclared instead of letting a farther tenancy decorator declare it; a class of the same name from another package no longer counts. The merge in `@spinajs/manifest` still reads the written type name, so under a global `TenantMiddleware` mount such a route stays `required` in the app manifest.

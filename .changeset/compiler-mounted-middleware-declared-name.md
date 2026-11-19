---
"@spinajs/compiler": patch
---

A hand-written `@Middleware(Type, ...)` records the declared class name as `MiddlewareRef.type`, as the factory decorators already do, so a middleware imported under an alias keeps its name; the merge then sees an aliased `TenantMiddleware` mount and keeps its route at `none` under a global mount. Decorators and mounted types now resolve their package as `isDeclaredIn` does, past a nameless nested `package.json`.

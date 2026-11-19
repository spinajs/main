---
"@spinajs/authz-http": patch
---

A failed authz boot is visible to the process: when the root domain cannot boot, or `authz.http.unguardedRoutes: 'throw'` finds an unguarded route, `PrincipalMiddleware` still stops the HTTP server and now also sets `process.exitCode = 1` and emits `authz.boot.failed` on the root container. Exit at once with `DI.on('authz.boot.failed', () => process.exit(1))`.

---
"@spinajs/http": major
---

`RouteIndex`: the mounted controller routes, matched in router order with the Express router's own matching (`match`, `matchAll`); the boot fails when the installed Express router no longer works as it reads it. Server middlewares get the route the request will match in `onBefore` and `onAround` (`ctx.route`, `ctx.controller`, `ctx.path`), a best-effort pre-routing match. `CsrfGuard` exempts a request only when every route that could serve it is `@CsrfExempt()` (`controllers()` is removed; `isExempt(ctx, paths)` is the override point). New `@Cors({ origins, credentials?, maxAge? })` on an action or controller replaces `http.cors.origins` for its framework replies, and for a preflight when every route serving it shares the policy; an overridden `allowance()` clamps it, `http.cors.allowRoutePolicies: false` ignores it, and the mounted route policies are logged. `CorsMiddleware` is now always mounted so `@Cors` routes work without `http.cors`.

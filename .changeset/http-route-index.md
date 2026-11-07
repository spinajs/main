---
"@spinajs/http": major
---

`RouteIndex`: the routes the controllers registered, by method and mounted path, matched as the Express router matches them. Server middlewares get the route the request will match in `onBefore` and `onAround` (`ctx.route`, `ctx.controller`, `ctx.path`), a best-effort pre-routing match. `CsrfGuard` reads `@CsrfExempt()` from that match (`controllers()` is removed; `isExempt(ctx, paths)` is the override point). New `@Cors({ origins, credentials?, maxAge? })` on an action or controller replaces `http.cors.origins` for its routes, preflights included; `CorsMiddleware` is now always mounted so `@Cors` routes work without `http.cors`.

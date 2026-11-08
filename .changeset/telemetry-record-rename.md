---
"@spinajs/telemetry": major
---

`TelemetryMiddleware` runs on the `@spinajs/http` server middleware hooks: `onBefore(ctx)` starts the clock and the in-flight gauge, `onFinish(ctx)` balances the gauge and, unless `ctx.aborted`, calls `record(ctx)`. Breaking for subclasses: the protected `onFinish(req, res)` is now `record(ctx: IFinishContext)` (call `super.record(ctx)`), `routeLabel(req)` is `routeLabel(ctx: IMiddlewareContext)` and prefers the matched route's mounted path (`ctx.path`) over `req.route.path`, `req.storage.route` is no longer read, and `before()`/`after()` are gone: skip a request by overriding `onBefore(ctx)` without calling `super.onBefore(ctx)`.

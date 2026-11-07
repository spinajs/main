---
"@spinajs/http": major
---

The deprecated `ServerMiddleware.before()`/`after()` adapter is removed, with the `LegacyServerHandler` type. A server middleware, or a `NotFoundMiddleware`/`ErrorHandlerMiddleware` replacement, that still defines `before()` or `after()` fails `HttpServer.resolve()` with an `InvalidOperation` naming the class, instead of being ignored. Implement `onBefore`, `onAfter`, `onFinish`, `onAround` or `handler()` (`reply()` for the tail classes); see "Migrating from before() and after()" in the server middlewares guide.

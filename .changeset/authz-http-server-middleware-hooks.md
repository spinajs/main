---
"@spinajs/authz-http": major
---

`PrincipalMiddleware` resolves the principal in `onBefore(ctx)` and `AccessEpochMiddleware` sets `X-Access-Epoch` in `onAfter(ctx)`: the header now carries the epoch of the principal as it is when the reply leaves, on error replies and the 404 as well, and no longer on static files or replies an action wrote to `res` itself. Breaking for subclasses: neither has `before()`/`after()` any more, and a subclass that overrides them fails `HttpServer.resolve()`; override `onBefore(ctx)` or `onAfter(ctx)` instead.

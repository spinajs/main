---
"@spinajs/authz-http": patch
---

`PrincipalMiddleware` resolves the principal in `onBefore(ctx)` and `AccessEpochMiddleware` sets `X-Access-Epoch` in `onAfter(ctx)`: the header now carries the epoch of the principal as it is when the reply leaves, on error replies and the 404 as well. Neither has `before()`/`after()` any more.

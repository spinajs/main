---
"@spinajs/authn-http": major
---

`ClientIp`, `CsrfOriginGuard` and `AuthnMiddleware` run on the `@spinajs/http` server middleware hooks; none has `before()`/`after()` any more. `AuthnMiddleware.onBefore(ctx)` authenticates; store errors, the `authn.request` 403 and the repeated-credential 400 answer as before, through the global error answer. `ClientIp` parses its proxy trust in `resolve()`. `CsrfOriginGuard` reads its proxy trust and reports the deprecated `authn.http.csrf.*` keys in `isEnabled()`, at mount; a subclass that wrapped `super.before()` overrides `onBefore(ctx)` or `refuse()` instead.

---
"@spinajs/intl-http": major
---

`IntlHttpMiddleware` runs on the `@spinajs/http` server middleware hooks: `onBefore(ctx)` stores what the new protected `detectLanguage(req)` returns. `before()`/`after()` are gone; a subclass that wrapped `super.before()` overrides `detectLanguage(req)` and calls `super.detectLanguage(req)`.

---
"@spinajs/http": minor
"@spinajs/authn-http": minor
---

`RouteMiddleware.documentation?(route)` returns an `IRouteMiddlewareDoc` (`responses` of `IDocumentedAnswer`, success `headers` of `IDocumentedHeader`, `extensions`) for API document generators. `BaseController.MountedMiddlewares(method)` lists the middlewares mounted on a route, in mount order, and `IRouteChainOptions.onMounted(enabled)` of `buildRouteHandlers` reports them once the registrations succeeded.

`RateLimitMiddleware.documentation(route)` describes a mounted limit for API documents: the default 429 (`E_TOO_MANY_REQUESTS` body, `Retry-After`; the shared `TooManyRequests` response unless the route is closed or sends `X-RateLimit-*`), and, only when the resolved `headers` is on, the headers the middleware sends: `X-RateLimit-*` and `Retry-After` on every throttled answer, the default one or a marked `answer` (a closed route: `X-RateLimit-Limit` and `X-RateLimit-Remaining` only), `X-RateLimit-*` on the success answers (none on a closed route), and an `x-rate-limit` extension with the effective `{ limit, windowSeconds, by }` (no `by` with a custom `key`). The configuration key is never documented. A custom `answer` documents nothing unless marked with the new `documentedAnswer(fn, { status, description, type?, retryAfter? })`, `retryAfter` for an answer that sets `Retry-After` itself; `answerDocOf(fn)` reads the mark. New exports: `documentedAnswer`, `answerDocOf`, `IAnswerDoc`.

`@spinajs/authn-http`: the throttled answers built on its `{ error: 'throttled', message }` 429 (reset, code, verification, registration, key and passkey challenges, and the session routes' default) are marked as a 429 `AuthnError` with `Retry-After`. The login-failure, password and MFA challenge answers stay unmarked. With `@spinajs/http-swagger`, the OpenAPI document of those routes gains that 429; the others are unchanged.

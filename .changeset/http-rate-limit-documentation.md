---
"@spinajs/http": minor
"@spinajs/authn-http": minor
---

`RateLimitMiddleware.documentation(route)` describes a mounted limit for API documents: the default 429 (`E_TOO_MANY_REQUESTS` body, `Retry-After`; the shared `TooManyRequests` response unless the route is closed or sends `X-RateLimit-*`), and, only when the resolved `headers` is on, the `X-RateLimit-*` headers on the 429 and the success answers plus an `x-rate-limit` extension with the effective `{ limit, windowSeconds, by }`. The configuration key is never documented. A custom `answer` documents nothing unless marked with the new `documentedAnswer(fn, { status, description, type?, retryAfter? })`; `answerDocOf(fn)` reads the mark. New exports: `documentedAnswer`, `answerDocOf`, `IAnswerDoc`.

`@spinajs/authn-http`: the throttled answers built on its `{ error: 'throttled', message }` 429 (reset, code, verification, registration, key and passkey challenges, and the session routes' default) are marked as a 429 `AuthnError` with `Retry-After`. The login-failure, password and MFA challenge answers stay unmarked.

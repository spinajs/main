---
"@spinajs/http": minor
"@spinajs/http-swagger": minor
"@spinajs/openapi": minor
---

OpenAPI documents `@Idempotent` routes in both builders. That is the `Idempotency-Key` header (required when the route requires it), the 400, 409 (with `Retry-After`) and 422 problem answers, and the `Idempotent-Replayed` header on success answers. A status the route already answers stays as it is. `IRouteMiddlewareDoc.requestHeaders` lets a route middleware document the request headers it reads; `@spinajs/http-swagger` adds them as header parameters. `IdempotencyMiddleware` documents itself through it.

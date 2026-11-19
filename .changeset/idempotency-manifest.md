---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

The manifest records `@Idempotent` routes as `RouteEntry.idempotency: { required }`, derived from the route's `IdempotencyMiddleware` entry by the new `idempotencyOf(middlewares)` of `@spinajs/manifest`. The field is additive and `MANIFEST_VERSION` stays 2; rebuild the manifest to fill it. It is set for the decorator of `@spinajs/http` under any import name, also on a redeclared inherited route. Options that are not a literal count as not required. `manifest:diff` reports three changes: a route that gains `@Idempotent` (breaking when the key is required), a route that loses it (breaking: a retried request runs again), and a change of whether the key is required.

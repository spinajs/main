---
"@spinajs/authz-http": patch
---

`AuthzFieldsMiddleware` and `UnscopedMiddleware` use the context hooks of `@spinajs/http`. The response-field filter runs in `onAfter` on success replies only and replaces the data through `Response.data`. `@Unscoped` on a route without `@Access` now fails the registration from `onRegister`, so the boot error is a `RouteRegistrationException` naming the middleware and the route, with the `AuthzConfigError` message.

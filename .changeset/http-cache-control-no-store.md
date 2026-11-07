---
"@spinajs/http": minor
"@spinajs/authz-http-admin": minor
"@spinajs/authn-http": patch
"@spinajs/teams-http": patch
"@spinajs/users-http": patch
---

`@spinajs/http` ships the route middlewares `CacheControl(maxAge, { private?, staleWhileRevalidate?, immutable? })` and `NoStore`, both registered as `RouteMiddleware`. `CacheControl` marks the replies of a GET, HEAD or FILE route cacheable and an error reply or a 4xx/5xx `no-store`, keeping a `Cache-Control` the answer set itself; `NoStore` sets `Cache-Control: no-store` and `Pragma: no-cache` on every reply, error replies included. `NO_STORE`, the `Cache-Control: no-store` header for one answer, is exported from `@spinajs/http`; authn-http, teams-http and users-http re-export it instead of keeping their own copy. `NoStore` of `@spinajs/authz-http-admin` is now the one of `@spinajs/http`, re-exported from the same path, and sets its headers in `onAfter`.

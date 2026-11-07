---
"@spinajs/http": minor
"@spinajs/authz-http-admin": minor
"@spinajs/authn-http": patch
"@spinajs/teams-http": patch
"@spinajs/users-http": patch
---

`@spinajs/http` ships the route middlewares `CacheControl(maxAge, { public?, private?, staleWhileRevalidate?, immutable?, redirects? })` and `NoStore`, both registered as `RouteMiddleware`. `CacheControl` marks a 2xx or 304 reply of a GET, HEAD or FILE route `max-age=<maxAge>` (`public` only when asked), downgraded to `private` for a request with `Authorization` or a reply that sets a cookie; it leaves redirects alone unless `redirects: true`, marks an error reply or a 4xx/5xx `no-store` and keeps a `Cache-Control` the answer set itself. `NoStore` sets `Cache-Control: no-store` and `Pragma: no-cache` before the route runs and on every framework reply, error replies included. When a reply fails while it is sent, the headers the `onAfter` hooks set on `res` for it are put back before the error reply goes out. `Response` has a `cookies` getter, and `Redirect` reports its status as `statusCode`. `NO_STORE`, the `Cache-Control: no-store` header for one answer, is exported from `@spinajs/http`; authn-http, teams-http and users-http re-export it instead of keeping their own copy. `NoStore` of `@spinajs/authz-http-admin` is now the one of `@spinajs/http`, re-exported from the same path.

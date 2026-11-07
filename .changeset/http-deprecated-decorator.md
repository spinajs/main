---
"@spinajs/http": minor
"@spinajs/compiler": minor
---

`@Deprecated({ since, sunset?, link? })` mounts the new `DeprecationMiddleware`, which sets `Deprecation` (`@<unix seconds>` of the required `since`; RFC 9745), `Sunset` (RFC 8594) and `Link: <link>; rel="deprecation"` on every reply of the route or controller, error replies included. The compiler records the decorator as the route's `doc.deprecated`, so the generated OpenAPI operation is `deprecated: true`; at runtime both controller metadata providers mark every route that has a `DeprecationMiddleware` (`withDeprecatedRoutes`).

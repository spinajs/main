---
"@spinajs/http": minor
"@spinajs/compiler": minor
---

`@Deprecated({ since?, sunset?, link? })` mounts the new `DeprecationMiddleware`, which sets `Deprecation` (`@<unix seconds>`, or `true` without `since`; RFC 9745), `Sunset` (RFC 8594) and `Link: <link>; rel="deprecation"` on every reply of the route or controller, error replies included. The compiler records the decorator as the route's `doc.deprecated`, so the generated OpenAPI operation is `deprecated: true`.

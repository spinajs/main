---
"@spinajs/http": minor
---

`@Consumes(...types)` mounts the new `ConsumesMiddleware`, which answers 415 (`UnsupportedMediaTypeException`, the same answer shape as the 406 of `@Accepts`) to a request with a body whose `Content-Type` matches none of `types`; a request without a body passes. A route's own declaration replaces the controller's.

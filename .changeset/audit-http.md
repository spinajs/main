---
"@spinajs/audit-http": minor
---

New package `@spinajs/audit-http`: the `Audit` route middleware, moved out of `@spinajs/http` and rebuilt on `@spinajs/audit`. Mounted with `@Middleware(Audit, options?)` or as `'Audit'` in `http.routes.middlewares`, it records one `action` event per request: the redacted url, query and body (16 KB cap, sensitive keys redacted), the status, the duration, the error of an error reply, and `aborted` for a client that went away. A policy refusal is recorded with the outcome `denied`. The principal and its impersonator are the event's `actor` and `onBehalfOf`. Options live under `audit.http` (`methods`, `redact`, `includeBody`, `maxBodyBytes`, and new: `trail`, `action`). A trail that does not exist, or whose store is not installed, fails the registration of the route.

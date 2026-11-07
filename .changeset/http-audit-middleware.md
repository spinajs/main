---
"@spinajs/http": minor
---

New `Audit` route middleware: one `IAuditRecord` per request of a route, with the redacted URL, query and body, the status, the error of an error reply, the principal (`req.storage.Principal`, else `AuthnPrincipal`), the time and `aborted`, written once the response finished to the `AuditSink` service. The default `LogAuditSink` logs it on the `audit` logger; register an own `AuditSink` to store it elsewhere. A failing sink is logged on the `http` logger and never fails the request. Mount it with `@Middleware(Audit, options?)` or as `'Audit'` in `http.routes.middlewares`. `http.audit { methods, redact, includeBody, maxBodyBytes }` configures it, route options override it and add redact keys. Redaction is recursive and matches keys as case-insensitive substrings (default `password`, `token`, `secret`, `authorization`, `cookie`, `card`).

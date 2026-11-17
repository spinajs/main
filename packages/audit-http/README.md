# `@spinajs/audit-http`

The `Audit` route middleware: one `action` event of the audit trail (`@spinajs/audit`) per request of a route, with
the redacted url, query and body, the status, the error and the time. `@spinajs/http` itself has no audit code.

- Mount it with `@Middleware(Audit, options?)` on a route or a controller, or for every route with
  `http.routes.middlewares: ['Audit']`.
- `audit.http { methods, redact, includeBody, maxBodyBytes, trail, action }` configures every mount; the options of
  a mount override it, and its `redact` list adds to the configured one.
- The actor, the impersonator (`onBehalfOf`), the client address and the trace id come from the audit context.
- The events go to the `default` trail unless `trail` names another. That trail is a table (`@spinajs/audit-orm`);
  without that package set `audit.trails.default.store` to `LogAuditStore`, or the application does not boot.

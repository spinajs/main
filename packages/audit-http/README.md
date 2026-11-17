# `@spinajs/audit-http`

The `Audit` route middleware: one `action` event of the audit trail (`@spinajs/audit`) per request of a route, with
the redacted url, query and body, the status, the error and the time. `@spinajs/http` itself has no audit code.

- Mount it with `@Middleware(Audit, options?)` on a route or a controller, or for every route with
  `http.routes.middlewares: ['Audit']`.
- `audit.http { methods, redact, includeBody, maxBodyBytes, trail, action, rules }` configures every mount; the options of
  a mount override it, and its `redact` list adds to the configured one.
- The actor, the impersonator (`onBehalfOf`), the client address and the trace id come from the audit context.
- The events go to the `default` trail unless `trail` names another. That trail is a table (`@spinajs/audit-orm`);
  without that package set `audit.trails.default.store` to `LogAuditStore`, or the application does not boot.
- On a trail with `onFailure: 'reject'` an `attempt` event is confirmed before the policy gate and the action run,
  and the outcome follows under the same `data.invocation`; when the attempt cannot be recorded the request is
  answered 503 and nothing of the route runs.
- `audit.http.rules` (`{ match: 'DELETE /admin/**', action, trail }`) give the matching routes where `Audit` is
  mounted their own action or trail; a rule does not mount `Audit`.
- Docs: [Audit](../../docs/audit-http/01-audit.md).

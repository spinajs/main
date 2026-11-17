---
"@spinajs/http": patch
---

The `Audit` route middleware, `AuditSink`, `LogAuditSink`, `IAuditRecord` and the `http.audit` configuration are no longer part of `@spinajs/http`. They were added during 4.0 development and never released, so no released application uses them. The middleware continues in `@spinajs/audit-http` under the same class name, recording into the audit trail of `@spinajs/audit`; `@spinajs/http` depends on no audit package.

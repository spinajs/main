---
"@spinajs/audit": minor
---

New package `@spinajs/audit`, the core of the audit trail: the `AuditEvent` shape, the ports `AuditStore`, `AuditReader`, `AuditEventSink` and `AuditContext` (default: the request store http, authn and authz share), named trails under `audit.trails` with the built-in `default`, `history` and `security`, and masking by `omit`, `mask` and `hash` paths. `trailConfig`, `trailNames` and `auditContext` take an optional container and read through its lineage. The `audit` configuration root is open: other packages register their own sections under it.

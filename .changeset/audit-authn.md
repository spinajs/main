---
"@spinajs/audit-authn": minor
---

New package `@spinajs/audit-authn`: `AuthnAuditRecorder`, an `AuthnEventListener` that records every authentication event as a `security` event in the audit trail named by `audit.authn.trail` (default: the built-in `security` trail, the log with identifiers hashed). `securityInput()` maps an `AuthnEvent` to an `AuditInput`. When the trail has `onFailure: 'reject'` the recorder is a blocking listener: an authentication success whose event cannot be recorded fails with HTTP 503 and issues no session.

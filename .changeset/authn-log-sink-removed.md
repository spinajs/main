---
"@spinajs/authn": major
---

`LogAuthnAuditSink` and `authn.audit.hashIdentifiers` are removed: `@spinajs/authn` no longer writes authentication events to the log. `@spinajs/audit-authn` records them in the audit trail; its default `security` trail is the log with identifiers hashed. `authn.audit.hashKey` remains as the row-key secret of `DbAuthnThrottle`.

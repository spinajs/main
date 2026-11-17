---
"@spinajs/authn-orm": major
---

`@spinajs/authn-orm` no longer stores authentication events: `DbAuthnAuditSink` and the `AuthnAudit` model are removed. The initial migration no longer creates `authn_audit`; an existing table is left in place and can be dropped by hand (see the upgrade guide). The replacement is a table trail of `@spinajs/audit-orm` named by `audit.authn.trail` of `@spinajs/audit-authn`.

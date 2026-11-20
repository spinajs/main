---
"@spinajs/authn-orm": major
"@spinajs/authn": major
---

`AuthnAuditRetention` and the `authn:audit-purge` command of `@spinajs/authn-orm` are removed, with the keys `authn.audit.retentionDays` and `authn.audit.purgeInterval`, which are now refused at boot. The package ships no CLI command and no longer depends on `@spinajs/cli`. Retention belongs to the audit trail: a table trail of `@spinajs/audit-orm` has its own `retentionDays`.

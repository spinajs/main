---
"@spinajs/audit-orm": patch
---

A second read rule for a model is refused: `@AuditReads` or `registerAuditReads` for a class name that already has a rule throws `AuditConfigError`, naming the entry that declared the first one, instead of silently replacing it.

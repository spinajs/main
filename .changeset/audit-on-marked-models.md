---
"@spinajs/audit-orm": minor
---

`Model.audit()` and `row.audit()` exist on models marked with `@Auditable()` of `@spinajs/audit-orm` (the model declares the typing); `auditOf(model | row, trail?)` reads the same for any model. Their result types, `ModelAudit` and `RowAudit`, are exported by `@spinajs/audit-orm`.

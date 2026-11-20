---
"@spinajs/orm": minor
"@spinajs/audit-orm": minor
---

`Model.audit()` and `row.audit()` exist on models marked with `@Auditable()` of `@spinajs/audit-orm` (the model declares the typing); `auditOf(model | row, trail?)` reads the same for any model. `ModelBase.audit()`, `ModelAuditSource`, `modelAuditSource`, `ModelAudit` and `RowAudit` leave `@spinajs/orm`, and `OrmModelAuditSource` leaves `@spinajs/audit-orm`; the two result types are now exported by `@spinajs/audit-orm`.

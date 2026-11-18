---
"@spinajs/audit": minor
---

A trail without `table` uses the table `audit_<trail>` instead of `audit_event`; `default` keeps `audit_event` and `history` keeps `orm_history`. A trail whose name is not a plain identifier (`^[a-z][a-z0-9_]{0,56}$`) and that names no `table` is refused with `AuditConfigError`.

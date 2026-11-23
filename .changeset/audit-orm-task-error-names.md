---
"@spinajs/audit-orm": patch
---

`AuditShipError` and `AuditSealError` extend `Exception` of `@spinajs/exceptions`, so a failed shipping or sealing run is recorded under its own error name instead of `Error`.

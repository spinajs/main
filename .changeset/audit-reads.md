---
"@spinajs/audit-orm": minor
---

`@AuditReads({ trail, mode, columns, onFailure })` and `registerAuditReads()` record selects of a model in an audit trail: one `read` event per returned row (`mode: 'row'`) or per statement (`mode: 'query'`), written before the rows are returned. `ReadAuditMiddleware` (a `QueryMiddleware`, order 200) rejects the select with `AuditWriteFailed` when the record cannot be written and the rule does not say `onFailure: 'continue'`. Row mode on a model without a primary key is refused when the rule is declared. Without a rule nothing changes.

---
"@spinajs/audit": patch
---

`MemoryAuditReader.redact` (`@spinajs/audit/testing`) follows the `AuditReader.redact` contract: it leaves erasure records alone and counts only payloads it blanked, so a second `forget` of one subject returns 0 and keeps the first erasure record's count.

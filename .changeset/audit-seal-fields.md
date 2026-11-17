---
"@spinajs/audit": major
"@spinajs/audit-orm": minor
---

A seal covers every stored field of an event but `seq`, which enters through the order of the seal's digests: `eventDigest` now also hashes `onBehalfOf`, `traceId`, `origin`, `tenant`, `decisionId`, `idempotencyKey`, `dataSubject` and the `source` an archive files the event under (`null` when absent), so on a sealed trail impersonation, tenant, data subject and source can no longer be rewritten undetected. Seals written with the earlier digest do not verify.

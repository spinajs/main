---
"@spinajs/audit": major
"@spinajs/audit-orm": minor
---

A seal covers every stored field of an event but `seq`, which enters through the order of the seal's digests: `eventDigest` now also hashes `onBehalfOf`, `traceId`, `origin`, `tenant`, `decisionId`, `idempotencyKey`, `dataSubject` and the `source` an archive files the event under (`null` when absent), so on a sealed trail impersonation, tenant, data subject and source can no longer be rewritten undetected. Seals written with the earlier digest do not verify.

A seal stores `events_hash` (`eventsHash(digests)`, the hash of its events' digests in `seq` order, a new column of `audit_seal`), and its `hash` is `sealHash(previous, sealedAt, events_hash)`: its own time is hashed (the sealer stores it at whole seconds), and every seal's hash can be checked from its row, also after retention removed its events, so a writer to `audit_seal` cannot move `sealed_at` without breaking the chain. `audit_seal` gained the column in a migration that was never released: a development database created before it drops and re-creates `audit_seal` (seals made without `events_hash` fail to insert, and verify reports the old ones as `seal`).

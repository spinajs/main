---
"@spinajs/audit": minor
"@spinajs/audit-orm": minor
---

`audit().trail(name).verify(source?, pinned?)` now works on table and archive trails: `TableAuditReader` and `ArchiveAuditReader` recompute the seals of a sealed trail, each over its range from the end of the previous seal, and report intact and redacted events, pruned seals, the unsealed tail and the first mismatch (`payload` with the exact event, or `seal`, `count`, `chain` with the seal's range). Rows a seal does not cover are listed in the report's `uncovered`, not reported as tampering: `late` for a row committed (or inserted) into a range after it was sealed, `pruned` for a row in a range retention removed. `unexplainedRedactions` lists blanked payloads with no `erasure` record of their subject. A `pinned` head (`{ toSeq, hash }`, from the sealer's log) must be met on the chain. `spinajs audit:verify <trail> [--source <connection>] [--head <toSeq>:<hash>]` prints the report and exits with code 1 on a mismatch or an unexplained redaction.

Every seal's hash is recomputed from its row (`previous_hash`, `sealed_at`, `events_hash`) before its events are read, pruned seals included, so a pinned head covers every `sealed_at` before it, and a seal whose time or events hash was moved is `seal`.

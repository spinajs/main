---
"@spinajs/audit": minor
"@spinajs/audit-orm": minor
---

Optional seal keys. `audit.seal.keys: [{ id, secret }]` makes every new seal an HMAC-SHA256 signed with the first key, its id stored in the new nullable column `audit_seal.key_id`; every listed key verifies the seals it signed, so a key is rotated by adding the new one first. Without keys sealing stays keyless. `sealHash` takes an optional key. With keys set a keyless seal is lawful only up to `audit.seal.keylessUpTo` of its table (none without an entry), so a keyed chain rewritten keyless fails, and the sealer refuses to sign on top of such a seal. A chain may turn keyed there but never back: the sealer refuses a keyless seal after a keyed one or past `keylessUpTo`, and `verify` reports one as tampered (`seal`). A key stops forged seals, not the sealer re-signing a rewrite after a kept seal on the live system: keep pinning heads. `AuditVerifyReport` gains `unverifiable` (a seal whose key is not configured, where the walk stopped) and `keylessHead` (keys configured, newest seal keyless: suspect). `spinajs audit:verify` answers `CANNOT VERIFY` with exit code 4 for a missing key, and counts a keyless head as SUSPECT.

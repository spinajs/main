---
"@spinajs/audit": minor
"@spinajs/audit-orm": minor
---

Optional seal keys. `audit.seal.keys: [{ id, secret }]` makes every new seal an HMAC-SHA256 signed with the first key, its id stored in the new nullable column `audit_seal.key_id`; every listed key verifies the seals it signed, so a key is rotated by adding the new one first. Without keys sealing stays keyless. `sealHash` takes an optional key. A chain may turn keyed in the middle but never back: the sealer refuses a keyless seal after a keyed one and `verify` reports one as tampered (`seal`). `AuditVerifyReport` gains `unverifiable` (a seal whose key is not configured, where the walk stopped) and `keylessHead` (keys configured, newest seal keyless: suspect). `spinajs audit:verify` answers `CANNOT VERIFY` with exit code 4 for a missing key, and counts a keyless head as SUSPECT.

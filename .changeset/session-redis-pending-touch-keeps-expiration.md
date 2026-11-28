---
"@spinajs/session-provider-redis": patch
---

`RedisSessionStore.touch` of a pending (pre-MFA) session no longer writes the expiration: it writes `Data` and keeps the stored instant, and the key keeps its `PEXPIREAT`. Before, a pending view without `Expiration` dropped the field and `PERSIST`ed the key, so a pending session could live forever and be elevated at any later time, and a view with a later `Expiration` extended the pending session. A pending view with an earlier `Expiration` no longer shortens the session either; to end a pending login early, revoke it (`SessionIssuer.revoke`, which deletes the row).

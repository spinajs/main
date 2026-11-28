---
"@spinajs/session-provider-db": patch
---

`DbSessionStore.cleanupExpired()` deletes pending sessions stored without an expiration. Before, the sweep deleted only rows whose `Expiration` had passed, so a pending row with a `NULL` expiration was never swept, although `isExpired()` counts it as expired and `restore()` no longer returns it. A pending row with a `NULL` or unknown `State` is swept too; an active row without an expiration is kept.

Upgrading: the first sweep after the upgrade deletes the pending rows stored without an expiration; their users sign in again. The issuer always stores a pending row with its `pendingTtlSeconds` expiration, so such rows were only ever written by older store code or by hand.

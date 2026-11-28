---
"@spinajs/authn-session": patch
---

An active `touch` whose view carries no `Expiration` no longer makes a session with a finite strategy never expire: under `AbsoluteExpiration` such a `touch` removed the session's end in every store. When the strategy's `renew()` gives no instant but its `initial()` does, the store now writes `initial()` (for `AbsoluteExpiration`, `Creation + ttl`). A row stored without an expiration (written under a never-expiring strategy) that is touched under a finite strategy now gets that strategy's end. A strategy whose `initial()` also returns `undefined` still renews to no expiration.

---
"@spinajs/authn-session": patch
---

`MemorySessionStore.touch` of a pending (pre-MFA) session writes only its `Data`, keeps the stored expiration and answers `false`. Before, a pending session in the memory store could live forever or be extended through `touch`: a session passed without `Expiration` left the row without one, so it never expired, and one with a later `Expiration` moved the deadline. An earlier or invalid `Expiration` is ignored as well; end a pending login early with `SessionIssuer.revoke`. Active sessions renew as before.

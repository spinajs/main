---
"@spinajs/session-provider-db": patch
---

Security: a `pending` session (between password and MFA) could be extended through `DbSessionStore.touch`: a view carrying a later `Expiration` had that value written to the row. A `touch` of a `pending` session now never writes the expiration column, whatever the view carries (later, earlier, absent or not a valid `DateTime`); it writes the session's `Data` and returns `false`, and the session ends when it was issued to end. Before, a view with an unreadable `Expiration` wrote the epoch and ended the pending session at once; it now keeps the issued expiration too. The issuer always touches a pending session it has just restored, which carries the stored expiration, so its flow is unchanged.

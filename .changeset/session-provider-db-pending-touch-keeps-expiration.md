---
"@spinajs/session-provider-db": patch
---

Security: `DbSessionStore.touch` of a `pending` session whose `Expiration` is absent (`undefined`) no longer writes `NULL`, which this table reads as "never expires". It now writes the session's `Data` and keeps the expiration stored for the row, so the pending session still ends when it was issued to end; `touch` returns `false`, as for any pending session. The issuer always touches a pending session it has just restored, which carries its expiration, so its flow is unchanged.

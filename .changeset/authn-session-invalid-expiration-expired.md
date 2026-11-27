---
"@spinajs/authn-session": patch
---

Security: a session whose `Expiration` is not a valid instant (an invalid luxon `DateTime`) is now expired in every store that uses the shared `SessionProvider.isExpired()`. Before, the comparison with an invalid `DateTime` was false, so such a session never expired: `MemorySessionStore` restored and listed it, and `DynamoDbSessionProvider` did the same for a numeric `Expiration` past the JavaScript date range. Only an absent `Expiration` means "never expires". `DefaultSessionIssuer` judges the session the same way after a renewal and after `elevate`, and a renewal that would make the expiry unreadable (`SlidingCappedExpiration` over an unreadable `Creation`) is written at once, so the session ends on that request. `session-provider-db` and `session-provider-redis` still store an invalid `Expiration` handed to `save` as "no expiry"; that write side is fixed separately.

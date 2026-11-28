---
"@spinajs/authn-session": patch
---

`SessionProvider.isExpired()` answers `true` for a pending session without a stored expiration. Such a row (between password and MFA) could be elevated to an aal2 session at any later time with one MFA code, because a missing expiration meant "never expires"; it now counts as expired in every store, so `restore`, `listBySubject`, the revocation counts and the issuer's `elevate` and `rotate` refuse it. An active session without an expiration still never expires.

Upgrading: a pending row stored without an expiration is no longer restored, listed or elevated; its user signs in again. The issuer always stores a pending row with its `pendingTtlSeconds` expiration, so such rows were only ever written by older store code or by hand.

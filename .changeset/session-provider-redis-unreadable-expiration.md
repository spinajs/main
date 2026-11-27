---
"@spinajs/session-provider-redis": patch
---

Security: a stored session whose `Expiration` is present but not an ISO 8601 instant (an empty string, `null`, `0`, `false`, a number) is now treated as expired: `restore` answers `null` and deletes the key as it does for an expired session, and listings leave it out. Before, an empty string, `null`, `0` or `false` read as "never expires", and a number such as `2099` read as that ISO year. Only an absent `Expiration` means a never-expiring session, which is what the store writes. Values the store wrote always read as before. A stored `Creation` that is not an ISO 8601 instant now reads as the epoch. Before, under `SlidingCappedExpiration`, the next `touch` wrote the session back without an `Expiration`, and it then never expired.

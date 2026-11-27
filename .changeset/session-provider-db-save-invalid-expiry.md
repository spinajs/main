---
"@spinajs/session-provider-db": patch
---

Security: `DbSessionStore.save` and `touch` no longer write an `Expiration` that is present but not a valid luxon `DateTime` as SQL `NULL`, which this table reads as "never expires". An invalid `DateTime`, a JS `Date`, a string, a number or `null` handed to `save` (or to `touch` of a `pending` session, which keeps its own expiration) is now written as the epoch, so `restore` answers `null` and listings leave the session out. Only an absent (`undefined`) `Expiration` is still written as `NULL`, and a valid `DateTime` is written as before. Pass a luxon `DateTime`; a session saved with a JS `Date` now ends at once.

---
"@spinajs/session-provider-db": patch
---

Security: `DbSessionStore.save` and `touch` no longer write an `Expiration` that is present but not a valid luxon `DateTime` as SQL `NULL`, which this table reads as "never expires". An invalid `DateTime`, a JS `Date`, a string, a number or `null` handed to `save` (or to `touch` of a `pending` session, which keeps its own expiration) is now written as the epoch, so `restore` answers `null` and listings leave the session out. Only an absent (`undefined`) `Expiration` is still written as `NULL`, and a valid `DateTime` is written as before. Pass a luxon `DateTime`; a session saved with a JS `Date` now ends at once. `touch` no longer throws `a.toMillis is not a function` (after its update had run) when the session's `Expiration` is not a luxon `DateTime`, and a pending `touch` with such a value now returns `false`. An `active` `touch` whose session view holds such a value, which used to throw after the renewal was written, now returns `true`.

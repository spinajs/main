---
"@spinajs/authn-session": patch
---

`MemorySessionStore.touch` answers `false` and writes nothing when the view's `State` differs from the stored row's, and otherwise writes only `Expiration` and `Data` onto the stored row, as the db, Redis and DynamoDB stores do: a `touch` can no longer turn a pending (pre-MFA) session active or replace its `Subject`, `Impersonator`, `Creation` or `ExternalKey`.

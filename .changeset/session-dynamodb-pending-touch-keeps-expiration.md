---
"@spinajs/session-provider-dynamodb": patch
---

`touch` of a `pending` session no longer writes `Expiration`: a view without one removed the TTL attribute, so a session between password and MFA could live forever and be elevated at any later time, and a view with a later one extended it. A pending `touch` now writes `Data` only and keeps the stored expiration.

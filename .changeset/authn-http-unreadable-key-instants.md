---
"@spinajs/authn-http": patch
---

The key listing (`GET /user/keys`) answers a key whose stored expiry or revocation cannot be read with `null` for that instant and `expired` or `revoked` set, instead of failing with 500.

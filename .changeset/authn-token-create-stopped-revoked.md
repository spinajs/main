---
"@spinajs/authn-token": patch
---

A token whose `token.create` a blocking listener stopped is revoked before `create` rejects with `AuthnListenerFailed` (503), and `token.create` is published again with `outcome: 'failure'` and `reason: 'listener_failed'`. Nobody received its plaintext, so no live token outlives a creation that could not be recorded. A revocation that fails is logged on `authn-token` and the 503 stands.

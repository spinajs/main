---
"@spinajs/http-socket": minor
"@spinajs/idempotency": minor
---

Behaviour change: the idempotency key scope of a restricted principal (a `ceiling` from a scoped token, signing key or role switch, `onBehalfOf`, `authn.impersonator`, a share link, `companions`) holds its authority as well as its `principalKey` and `clientId`, with the leased and the 3.x stores alike. Idempotency runs before the policies, so a scoped token or an impersonating admin of a user no longer gets the reply stored for that user's full session, nor the other way round. Unrestricted principals keep their keys; a key a restricted credential completed before the upgrade runs again when resent.

`@spinajs/idempotency`: `idempotencyPrincipal(principal)` and `isRestrictedPrincipal(principal)` build the principal part of a scope. The package now depends on `@spinajs/principal`.

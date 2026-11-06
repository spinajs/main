---
"@spinajs/authz": minor
---

Consistency tokens (Bet 6 Z5a). `check({ ..., consistency: { atLeast } })` answers from data at least as new as the write that returned the token: a token newer than any the domain has seen makes the decision caches skip everything stored before it, and from then on they key on its generation. A token the engine cannot read checks fresh. Models get the option in `DecisionRequest.consistency` and may ignore it. `AuthzAdmin.execute(..., { consistency: true })` returns the domain's token on every ok result when the backend reports its version (`AuthzAdminBackend.bumpVersion` may now return it; the memory backend does). `consistencyToken(generation)` and `tokenGeneration(token)` encode and read tokens.

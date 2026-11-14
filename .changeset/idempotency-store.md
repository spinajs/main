---
"@spinajs/idempotency": minor
---

New package `@spinajs/idempotency`: the leased store contract `IdempotencyStore` (a claim is a lease fenced by a token, with `claim`, `renew`, `complete`, `release`, `peek` and `sweep`), the in-process `MemoryIdempotencyStore`, the sha256 helpers `idempotencyKey` and `fingerprintOf`, and the errors `IdempotencyInFlight`, `IdempotencyKeyReuse`, `IdempotencyLeaseLost` and `IdempotencyOutcomeUnknown`. `@spinajs/idempotency/testing` ships the store conformance suite `describeIdempotencyStoreConformance`.

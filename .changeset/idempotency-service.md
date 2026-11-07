---
"@spinajs/idempotency": minor
---

`IdempotencyService.run(scope, key, fn, opts)` runs `fn` at most once per key while its reply is kept (`ttl`), replays the stored reply to a repeat, answers a concurrent repeat with `IdempotencyInFlight` (`retryAfterMs`) and a repeat with a different request fingerprint with `IdempotencyKeyReuse`. The claim is a lease (`idempotency.lease`, default `30s`) renewed while `fn` runs; a function that fails, or a reply that is not stored, releases the key, while `IdempotencyOutcomeUnknown` and a `crash: true` error keep it until the lease ends. `acquire()` exposes the claim and its handle for callers that settle elsewhere, and `sweep()` deletes up to `idempotency.sweepBatch` (default `500`) expired rows. The `idempotency.*` configuration (`store`, default `OrmIdempotencyStore`; `lease`, a duration or milliseconds above zero; `sweepBatch`; `sweepEvery`, default `5m`, reserved for a pending builtin sweep schedule and not read yet) is validated at boot.

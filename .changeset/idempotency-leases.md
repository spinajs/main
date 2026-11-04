---
"@spinajs/idempotency": minor
---

`IdempotencyLeases` claims a key and hands back an `IdempotencyHandle` that renews the lease every third of its length through the durable `Heartbeat` until it completes, releases or abandons the key; a refused renewal aborts `handle.signal` with `IdempotencyLeaseLost`. A repeat with another fingerprint is refused with `IdempotencyKeyReuse` whether the key is done or still running. `@spinajs/idempotency/testing` adds `ManualClock`, whose timers fire only inside `advance()`.

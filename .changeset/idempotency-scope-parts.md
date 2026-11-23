---
"@spinajs/idempotency": minor
---

`IdempotencyScope` takes optional `parts` (for example `tenant:acme`), hashed after the key: `[namespace, principal ?? null, key, ...parts]`. A scope without parts keeps the key it had before, so stored keys keep working.

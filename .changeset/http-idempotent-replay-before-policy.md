---
"@spinajs/http": minor
"@spinajs/idempotency": minor
---

Behaviour change: `@Idempotent` replays a completed key of an authenticated principal before the policy gate, when the request has the stored fingerprint, so the resend of a committed operation (a delete whose row is gone, a state change a policy now refuses) gets its stored reply instead of a 403 or 404. The policies and the action do not run for it; the reply goes through the reply pipeline, where the server middlewares and the route's `'beforePolicy'` middlewares (`Audit` included) see it in `onAfter`, while the `'outer'` and `'inner'` route middlewares are not entered. This is the single exception to "the policies always run after the `'beforePolicy'` middlewares": the replay needs the same principal and the same request fingerprint, and nothing executes. Policies that do not depend on the principal (IP allowlist, MFA step-up, tenant header) are not evaluated again on such a replay, and a principal whose permission was revoked within `ttl` still gets the reply it was owed. Anonymous callers (one shared scope), keys in flight, reused keys, records without a fingerprint and a failing store (logged) go through the policies and the claim as before; 401 and 403 are still never stored.

`IdempotencyService.peek(scope, key)` reads a scoped key without claiming it, at database time.

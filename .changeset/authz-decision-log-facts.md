---
"@spinajs/authz": minor
"@spinajs/authz-orm": minor
---

Decision records carry what a replay needs. Every record gets `facts` (the principal's and actor's type, id, ceiling, delegation chain and companion keys; never attributes or authn), `loggedAt` (the wall clock when the tap recorded; `at` stays the caller's `env.now` when one was passed) and `durationMs`. With `captureInputs`, `inputs` also holds `principalState` and `actorState`, the exact strings `inputsHash` hashed. Without a `DecisionTraceContext`, `traceId` comes from the request store (the id changelog rows carry) or the active span, and `spanId` from the active span of that trace. New exports: `inputsHashParts`, `inputsHashOf` (`inputsHash` output is unchanged), `principalFacts`, `parseResourceKey`, `ambientTraceId`.

`@spinajs/authz-orm/audit`: migration `AuthzDecisionLogFacts_2026_11_06_00_00_00` adds the nullable `facts`, `logged_at` and `duration_ms` columns to `authz_decision_log`, which `DbDecisionLog` fills; `readDecisionRecord(id)` reads a record back from the primary and names the keys the log truncated.

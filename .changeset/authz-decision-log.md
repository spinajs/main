---
"@spinajs/authz": minor
---

Decision log (Bet 6 L1). `DecisionLog` receives `DecisionRecord`s (id, instant, trace ids, principal, permission, resource, outcome, policy hash, model versions and `inputsHash`, a SHA-256 of what the decision read) from a `DecisionLogTap`, which the host adds when `authz.decisionLog.mode` is not `off` and a `DecisionLog` is registered. `mode` defaults to `deny`; `sampled` logs every denial and `allowSampleRate` of the allows, `all` logs everything. Records are written in batches (`batch.size`, `batch.flushMs`); a failed write is logged and never fails a check. `captureInputs` (unset: on outside production) stores the read set with each record. A denial made while a tap is registered carries `Decision.id`, the id of its record. `PolicyHashSource` and `DecisionTraceContext` are the ports through which the policy hash and the trace and span ids reach the records.

The DecisionTap read set now records the env the check ran with rather than wrapping it, so models see the same request with or without a tap, and it is built only when a tap reads it.

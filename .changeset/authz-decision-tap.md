---
"@spinajs/authz": minor
---

`DecisionTap` (`@spinajs/authz`) sees every top-level decision of `check`, `explain`, `checkMany`, `checkAll`, `filter` and `filterNow` once it is final, with the request, a `DecisionReadSet` (the env keys, attributes and relations it read, and the model versions) and `{ cached, durationMs }`. Register one in DI (`DecisionTap`) or pass `taps` to `Authorizer`. Reads are recorded only while a tap is registered; without one the engine does no extra work. A tap that throws or rejects is logged and ignored. summary, covers and inspect are not tapped.

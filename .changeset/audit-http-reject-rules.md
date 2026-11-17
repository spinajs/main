---
"@spinajs/audit-http": minor
---

`Audit` on a trail with `onFailure: 'reject'` confirms an `attempt` event before the policy gate and the action run, and records the outcome under the same `data.invocation` once the response finished. When the attempt cannot be recorded the request is answered 503 (`AuditUnavailable`, registered for `AuditWriteFailed`) and nothing of the route runs; a trail the audit service refuses as misconfigured answers 500. `audit.http.rules` (`{ match, action, trail }`, `match` as `<METHOD or *> <path pattern>`) give matching routes their own action and trail where `Audit` is mounted. `matchesRoute` is exported. A policy that crashes (a 500 of the policy gate) is recorded as `failed`, not `denied`.

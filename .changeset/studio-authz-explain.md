---
"@spinajs/studio": minor
---

Spina Studio answers `POST /_studio/api/authz/explain`: the decision, its trace and the deny reasons sorted by priority, for a schema-validated body. It needs `studio:explain` and `authz:explain`, is rate-limited like `GET /authz/explain` and is recorded through the domain's `DecisionAudit` as an `explain` entry. In production the route is registered only with `studio.allowExplainInProduction: true` (default `false`), on top of `studio.allowProduction`; the `explain` capability says whether it is mounted. `@spinajs/studio/contracts` exports `StudioDecision` (the wire form of a decision) and re-exports `DenyReason`, `Trace` and `ResourceFilter`.

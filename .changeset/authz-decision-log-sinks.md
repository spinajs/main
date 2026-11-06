---
"@spinajs/authz-orm": minor
"@spinajs/authz-http": minor
"@spinajs/telemetry-otel": minor
---

Decision log sinks (Bet 6 L1). `@spinajs/authz-orm/audit` adds `DbDecisionLog`, which appends each batch of decision records to `authz_decision_log` (migration `AuthzDecisionLog_2026_11_04_00_00_00`, on the `authz-audit` connection); register it as the `DecisionLog`. `@spinajs/telemetry-otel` adds `OtelDecisionLog`, which emits each record as an OTel log record through the global LoggerProvider, and `OtelDecisionTraceContext`, which gives records the active span's trace and span ids and marks that span with `spina.authz.decision_id`. A 403 from `@Access` carries `decisionId` whenever the denial has one, in every environment.

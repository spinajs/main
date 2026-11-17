---
"@spinajs/studio": minor
---

Spina Studio answers `GET /_studio/api/traces` (filters `route`, `name`, `status`, `minDurationMs`, `principalId`, `from`, `to`, cursor pages), `GET /_studio/api/traces/:traceId` (spans and the trace's log lines) and `GET /_studio/api/traces/stream` (server-sent `trace` events, one per finished root span; a stream is closed after 15 minutes so a reconnect re-checks access, and at most 16 are open), plus `GET /_studio/api/logs`. Every query and path value is schema-validated. Log lines are buffered by the opt-in `StudioLogTarget`: add `{ name: 'Studio', type: 'StudioLogTarget' }` to `logger.targets` and route a rule to it.

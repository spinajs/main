---
"@spinajs/studio": minor
---

Spina Studio answers `GET /_studio/api/routes`: every mounted route with its route and controller policies, `@Access` permissions, anonymous and unguarded flags, the manifest source location when a manifest is loaded, count, error rate, p50 and p95 latency from the trace buffer, and request counts from `@spinajs/telemetry` when it is installed. `GET /_studio/api/authz/access-map` joins routes, the permissions they require and the RBAC roles granting them.

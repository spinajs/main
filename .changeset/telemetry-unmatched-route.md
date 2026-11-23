---
"@spinajs/telemetry": patch
---

A request no route matched is labelled `route="<unmatched>"` (`UNMATCHED_ROUTE`) instead of its raw path, in `http_requests_total`, `http_request_duration_ms` and `/telemetry/routes`, so a caller can no longer create Prometheus series by inventing URLs. Matched routes keep their pattern.

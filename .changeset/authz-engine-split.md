---
"@spinajs/authz": patch
---

The engine's `authorizer.ts` is split into files of at most about 500 lines under `engine/` (`types.ts`, `support/`, `cache/`, `context/`, `pipeline/`, `plan/`, `summary/`). Decisions, caching, auditing and the public API do not change; `AuthorizerOptions`, `RequestScope` and `MAX_SUMMARY_PERMISSIONS` are still exported from the same place.

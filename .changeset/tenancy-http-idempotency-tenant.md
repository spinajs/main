---
"@spinajs/tenancy-http": minor
---

An idempotency key never crosses tenants: `TenantIdempotencyScope` adds the tenant scope of a request or a socket connection to the scope of its `@Idempotent` and socket idempotency keys (`tenant:<id>`, `tenant:*` across all tenants). The same principal, or anonymous callers, sending one key in two tenants run once in each, and are neither replayed nor refused as in flight or reused across them. A request or connection without a tenant scope keeps its key. Upgrading changes the stored keys of requests and connections in a tenant scope: a resend made across the upgrade runs again within `ttl`.

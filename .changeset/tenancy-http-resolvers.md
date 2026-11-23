---
"@spinajs/tenancy-http": minor
---

New package `@spinajs/tenancy-http`, first part: where the tenant of a request comes from. Six `TenantResolver`s, asked in the order of `tenancy.http.resolvers`: `domain`, `subdomain` (both need `tenancy.http.baseDomains`), `path`, `header` (honoured only for an authenticated principal), `principal`, `session`. `resolveTenant()` takes the first proposal and admits it against the registry and `TenantAccess`.

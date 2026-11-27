---
"@spinajs/tenancy": minor
---

`TenantAccess.admitsVisitor(principal, tenant)`: `admitTenant` asks it, instead of `canEnter`, for a principal that is given and not authenticated (anonymous, `UNATTENDED`). The default admits, as before, so a rule of your own that only implements `canEnter` behaves as it did. Override it to close a tenant to visitors. `canEnter` is still asked for authenticated principals only, and with no principal (the queue worker, the scheduler run hook, the CLI `--tenant` hook, an HTTP request without a principal) neither member is asked. A rule that throws from either member makes `admitTenant` reject with that error.

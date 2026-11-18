---
"@spinajs/tenancy": patch
---

`@spinajs/tenancy/queue`: a message runs only while its tenant is active. Before the handler, the hook admits the tenant the message names through the registry, as `admitTenant` does. A tenant that is unknown, `provisioning`, `suspended`, `deleting` or `deleted` is refused with the permanent failure `tenant_unavailable` (its `cause` is the registry's `TenantUnavailable`): the handler and the event callback do not run, and a job is dead after one attempt. A tenant in `provisioning` cannot run its own jobs either. A registry lookup that throws refuses the message as an ordinary, retried failure and is logged as a registry failure. Messages without a tenant and in the cross-tenant scope do not query the registry.

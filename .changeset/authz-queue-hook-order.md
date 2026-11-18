---
"@spinajs/authz-queue": major
"@spinajs/tenancy": patch
---

`AuthzQueueHook.order` is `-50` (was `0`). On emit it now writes `Initiator` after every hook of the default order, whatever the import order, so a hook registered before `@spinajs/authz-queue` is imported can no longer replace the stamp. The handling chain is `TenantQueueHook` (`-100`), then `AuthzQueueHook`, then the hooks of order `0`. Breaking: the hook order is public. A hook that needs the job's principal in `aroundHandle()` takes an order above `-50` (the default `0` still does); a hook of an order above `-50` and below `0` used to run outside `AuthzQueueHook` and now runs inside it, with the job's principal, and writes before it on emit. A subclass of `AuthzQueueHook` inherits the new order.

`@spinajs/tenancy`: the doc comment of `TENANT_QUEUE_HOOK_ORDER` names the new order.

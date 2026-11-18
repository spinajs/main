---
"@spinajs/queue": minor
---

`QueueMessageHook.beforeEmit()` now runs in the reverse of the `aroundHandle()` chain: the highest `order` first, and among hooks of one order the last registered first. The outermost hook on handling writes last on emit, so the stamping hooks (`TenantQueueHook`, `AuthzQueueHook`) write the fields they restore after every hook of a higher order and after hooks of their own order registered later. An order-0 hook registered before `@spinajs/authz-queue` is imported still writes after `AuthzQueueHook`. `aroundHandle()` order is unchanged. Behaviour change: hooks of one order now run `beforeEmit()` in reverse registration order; a hook that must run first on emit takes a higher `order`, and a hook of a higher order no longer sees the tenant header or `Initiator` in `beforeEmit()`.

---
"@spinajs/queue": minor
"@spinajs/tenancy": minor
---

`@spinajs/queue`: a new standard header `QueueHeaders.Tenant` (`x-spinajs-tenant`), the `@Job` option `tenancy: 'carry' | 'required' | 'none'`, and `QueueMessageHook.order` (default 0): the lowest order is outermost in `aroundHandle`, and hooks of one order keep their registration order, so existing hooks keep their place in it.

`@spinajs/tenancy/queue`: a message hook (order -100, ahead of the authz hook) that writes the emitter's tenant scope into the header and runs the handler in that scope, also on a retry or a redelivery. A value the caller or a hook of a higher order wrote under that name, in any letter case, is replaced. A malformed header is logged as a warning. `tenancy: 'required'` refuses a message that names no single tenant with the permanent failure `tenant_required`; `tenancy: 'none'` runs the handler with no scope.

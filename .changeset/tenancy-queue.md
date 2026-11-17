---
"@spinajs/queue": minor
"@spinajs/tenancy": minor
---

`@spinajs/queue`: a new standard header `QueueHeaders.Tenant` (`x-spinajs-tenant`), the `@Job` option `tenancy: 'carry' | 'required' | 'none'`, and `QueueMessageHook.order` (default 0): hooks run in ascending order, and hooks of one order keep their registration order, so existing hooks are unaffected.

`@spinajs/tenancy/queue`: a message hook (order -100, ahead of the authz hook) that writes the emitter's tenant scope into the header and runs the handler in that scope, also on a retry or a redelivery. A header the caller wrote is replaced. `tenancy: 'required'` refuses a message that names no single tenant with the permanent failure `tenant_required`; `tenancy: 'none'` runs the handler with no scope.

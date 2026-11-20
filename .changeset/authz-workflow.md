---
"@spinajs/authz-workflow": minor
---

New package: `AuthzSignalAuthorizer` replaces `DenyAllSignalAuthorizer`. A `waitForEvent(name, { permission, resource })` consumes a signal only when `@spinajs/authz` allows the principal the signal was stamped with, in the domain `authz.workflow.domain` (default `root`). A conditional allow on one row is denied. A wait without `resource` is checked on the permission's resource type. A signal without a principal is rejected, and so is every signal of a wait whose permission is not `resource:action` or whose resource is not `{ type, id? }`. The default `StampedSignalPrincipalFactory` trusts the signal's stamp as written and warns once (`authz.workflow.stampedPrincipalWarning`): a user deactivated after signing still passes. Register a `SignalPrincipalFactory` that reloads the user to close that; `@spinajs/users/workflow` is one.

---
"@spinajs/authz": minor
---

`AuthzService.audit?(entry)` writes an entry to the `DecisionAudit` the domain picked at boot (`authz.audit.service`, `authz.domains.<name>.audit.service`), so a host that audits an access of its own, such as the decisions route of `@spinajs/authz-http`, reaches the same trail as the engine. It never throws; a failure is logged.

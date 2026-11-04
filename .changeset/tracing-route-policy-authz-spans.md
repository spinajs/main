---
"@spinajs/http": minor
"@spinajs/authz": minor
"@spinajs/authn": minor
---

Every executed route policy runs in a `policy <Name>` span (`spina.policy.result` `allow`/`deny`, ERROR on deny), and argument hydration plus the action run in a `route <Controller>.<action>` span, both children of the HTTP server span. `Authorizer.check` opens an `authz.check` span with the domain, permission, resource, principal id, outcome, top deny reason and whether the decision came from a cache; a deny is not an error on that span. `explain` adds an `authz.explain` parent span. `DefaultAuthnService.authenticate` opens an `authn.authenticate` span with the strategy, status and, on success, the principal id. Principal claims are never recorded.

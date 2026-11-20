---
"@spinajs/authn-testing": minor
---

A21 gets the facet kind `log`: the case "A21 SR-19 failed logins log no login string" moves to `A21/log`, which `@spinajs/audit-authn` claims, and `A21/core` gains "A21 SR-19 failed-login events carry no login string", so an `AuthnService` claims `A21/core` with no `logs` port. "A21 SR-11 login and impersonation are audited by default" is renamed "A21 SR-11 a login publishes its success and session.issue events".

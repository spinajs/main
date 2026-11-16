---
"@spinajs/authz-abac": minor
"@spinajs/authz-rbac": minor
---

With `IRCompileContext.stored: 'opaque'` the ABAC model compiles only its config policies and adds the opaque term `stored:<model>:<store>` of each other store to the permit and deny relation of every registered permission, so the IR stays honest about what a stored policy could do. `abacPolicyTerms` exposes the per-permission terms. The RBAC stored-rules term is now named `stored:<model>:<store>` too (`RbacIROptions.storedRules` accepts the store name; a `DbRuleStore` gives `stored:rbac:DbRuleStore`). This changes the policy IR of every app with a `DbRuleStore`: its hash, and the name `authz:verify` and `authz:export` show for that term.

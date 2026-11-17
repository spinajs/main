---
"@spinajs/authz-rbac": minor
"@spinajs/authz-abac": minor
---

Decision replay splices DB-stored rules and policies into the config policy as they were at a decision's instant, in place of the `stored:<model>:<store>` placeholders. `@spinajs/authz-rbac` registers `RuleSplicer` (kind `rule`, `DbRuleStore`): the IR cannot express a rule, so each rule held at the instant that can match the permission (`ruleCanMatch`) stays an opaque term named `rbac rule <id>`, and the others drop out; with no applicable rule the replay is exact. A rule with an expiry is never dropped for it, since the splicer cannot tell the `now` the engine judged it at. `@spinajs/authz-abac` registers `PolicySplicer` (kind `policy`, `DbPolicyStore`): the policies held at the instant are compiled with `abacPolicyTerms` into the permit and deny relations of each permission, their caveats and opaque terms merged into the IR. In both, an item whose state at the instant is a gap, or whose image no longer loads, is an opaque term, and a store that logs no changes (a memory or config store) keeps its placeholder, or is a coverage gap of its kind when that kind is not covered.

New exports: `rbacDenyRelation` and `abacRelation` (the relations the placeholders sit in), `DB_RULE_STORE_NAME`, `DB_POLICY_STORE_NAME`, and `rowToRule` (the rule an `authz_rule` row and its subject rows hold).

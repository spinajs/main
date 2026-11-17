---
"@spinajs/authz-orm": minor
"@spinajs/authz-rbac": minor
"@spinajs/authz-abac": minor
---

Changelog rows carry before-images: `DbChangeLog.append` writes `ChangeEntry.before` to the `before` column. Every `put` of `DbAssignmentStore`, a rewritten rule and a rule `forgetScope` narrowed in `DbRuleStore`, and a replaced policy in `DbPolicyStore` log the state they replaced; a deleted policy logs the removed policy as its payload. A rule's `add` and `put` payload is now the rule as the store reads it back (with `expiresAt: null` when it has none), so it equals the before-image of the rule's next change. Rewriting an existing rule and replacing a policy each cost one more SELECT in their transaction.

`DbScopeAttributeStore` logs one row per changed leaf instead of one `{ set, remove }` row per node: key `attributeChangeKey(ref, path)` (sha256 hex of the scope key and the path, since both together can pass the 255-character key column), payload `{ scope, path, value }`; `add` for a fresh path, `put` with the old leaf as `before`, `remove` with the removed leaf, also for each leaf a set path drops above or below it. `forget` reads the node first (one more SELECT) and logs one `remove` per leaf.

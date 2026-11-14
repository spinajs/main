---
"@spinajs/authz-rbac": minor
"@spinajs/authz-abac": minor
"@spinajs/authz-orm": minor
---

The DB stores record their writes in `authz_change_log`, in the transaction of the write: `DbAssignmentStore` (kind `assignment`, keyed by assignment id: `add` on a grant, `put` on a re-grant, tag or expiry change, `remove` on every revocation), `DbRuleStore` (`rule`, by rule id; `scope.forget` logs the rules it deleted and, as `put`, the rules that lost a subject entry), `DbMembershipStore` (`membership`, by member key, the member's closure rows), `DbPolicyStore` (`policy`, by policy id) and `DbScopeAttributeStore` (`attribute`, by scope key, with the paths set and removed). Each store marks its kind as covered (`changeLog().covers(kind)`). `@spinajs/authz-abac` now depends on `@spinajs/authz-orm` for the changelog. Run the authz-orm migration `AuthzChangeLog_2026_11_04_00_00_00` before these stores write.

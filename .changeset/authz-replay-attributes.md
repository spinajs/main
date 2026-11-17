---
"@spinajs/authz-ir": minor
"@spinajs/authz-orm": minor
---

Decision replay checks captured scope attributes against their history. With `captureInputs`, every leaf the scope attribute store held at the decision's instant for a node the decision loaded is rebuilt from the `attribute` changelog; a known leaf the capture shows otherwise makes the replay `divergent` with `{ part: 'captured-state', key: '<scope>#<path>' }`. A leaf the store did not hold proves nothing (schema defaults and adapters fill nodes too), and a leaf the history cannot establish gives no finding and leaves the verdict as it is. The check reads the store only once the `attribute` kind is covered, and lists every leaf it resolved in `reads` with kind `attribute`; without a registered contributor it does not run and lists none.

`@spinajs/authz-ir`: `AttributeHistoryContributor`, its DI token `AttributeHistoryContributors`, `AttributeLeafImage`, and `ReplayDeps.attributes`. `@spinajs/authz-orm/replay` registers `ScopeAttributeHistoryContributor` over `DbScopeAttributeStore`, and `loggedLeaves` reads a node's leaves on the primary.

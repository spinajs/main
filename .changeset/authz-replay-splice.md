---
"@spinajs/authz-ir": minor
---

`replayDecision` splices DB-stored policy into the stored config IR before it evaluates: every `stored:<model>:<store>` placeholder a `StoredPolicySplicer` (`ReplayDeps.splicers`) locates is replaced by the store's items as they were at the decision's instant, each rebuilt with `stateAt` in the read order of the replay history (`spliceStoredPolicy`). A placeholder whose kind is not covered at that instant stays opaque, and two splicers that locate the same placeholder are an `AuthzConfigError`. `HistoricalTupleSource` now yields the subjects of a read in key order, so a replay walks them in the same order whatever the order of the writes that led to them. Property P3: a decision logged now and replayed after any later writes is `faithful`, with the same explain tree.

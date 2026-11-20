---
"@spinajs/authz-ir": minor
"@spinajs/authz-rbac": minor
"@spinajs/authz-rebac": minor
---

Decision replay rebuilds RBAC assignments and ReBAC tuples at a decision's instant. `@spinajs/authz-rbac` registers `AssignmentHistoryContributor` (kind `assignment`, the role relations of `authz_assignment`): current rows are read on the primary with expired ones included, and an assignment is live at the instant when it has no expiry or one after it, so a grant that expired after the decision still counts and one that expired before it does not. `@spinajs/authz-rebac` registers `TupleHistoryContributor` (kind `tuple`, `authz_rebac_tuple`): a change belongs to the key the store logged it under, and a conditional tuple's caveat, with its context, comes back as it was. `tupleOf` (the tuple a row holds) is exported. A grant or tuple deleted by raw SQL after the decision, with no logged change after it, is not seen (risk R1).

`@spinajs/authz-ir`: `HistoryContributor.precisionMs`, the precision of the instants inside a contributor's images (the store column's), used in place of the changelog's. `HistoricalTupleSource` takes the instant liveness is judged at (`replayDecision` passes the record's `at`, the caller's `env.now` when one was given), apart from the instant the state is rebuilt at (`loggedAt`): an assignment the engine saw live at `env.now` replays live.

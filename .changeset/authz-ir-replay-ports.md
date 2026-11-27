---
"@spinajs/authz-ir": minor
"@spinajs/authz-orm": patch
---

Decision replay in `@spinajs/authz-ir` reads history through ports it declares. `ReplayDeps` takes `history` (a `ReplayHistoryLoader`, which loads the `ReplayHistoryView` of one replay) and `keyState` (`KeyStateFunctions`: `stateAt`, `coverageGap`, `sameImage`) instead of `log: ChangeLog`; `HistoricalTupleSource` and `spliceStoredPolicy` take the view and the functions as arguments; contributors and splicers receive a `ReplayChange`, the change shape the package declares itself. `changeLogReplay(log)` and `changeLogKeyState` are the implementation over the authz changelog, which `DbDecisionReplay` of `@spinajs/authz-orm` passes in. `ReplayHistory.edges` is gone (`changesOf` with a contributor's `edges` gives the same), and a replay recognises a history budget stop by its shape (`replayBudgetStop`). No verdict, report or limit changes, and the replay API is not in any release yet.

---
"@spinajs/orm-history": minor
---

`Model.history()` (`of`, `asOf`, `since`, `forget`) and `row.history()` (`entries`, `asOf`, `forget`) on a model marked with `@History()`, which declares the two members; `historyOf(model)` and `historyOf(row)` for a model tracked by a rule or by `registerHistory`. All of them read the `data` events of the model's audit trail. `forget` redacts (entries stay, payloads go); `asOf` answers `present`, `absent`, `redacted` or `unknown`. `toHistoryEntry()` turns an audit event into a history entry.
